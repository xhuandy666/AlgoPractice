import type { Adapter, TestCase, ValueType, WireValue } from './types.ts';
import { observedType } from './values.ts';

const goString = (value: string) => `"${[...Buffer.from(value, 'utf8')].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`;
function goType(type: ValueType): string {
  if (typeof type !== 'string') return `[]${goType('array' in type ? type.array : type.list)}`;
  return { int: 'int', int64: 'int64', bigint: '*big.Int', float: 'float64', boolean: 'bool', string: 'string', char: 'byte', listnode: '*ListNode', treenode: '*TreeNode' }[type];
}
function literal(value: WireValue, type: ValueType): string {
  if (typeof type !== 'string') {
    const inner = 'array' in type ? type.array : type.list;
    return `${goType(type)}{${(value as WireValue[]).map(v => literal(v, inner)).join(',')}}`;
  }
  if (type === 'string') return goString(value as string);
  if (type === 'char') return `byte(${(value as string).charCodeAt(0)})`;
  if (type === 'int64') return `int64(${value})`;
  if (type === 'bigint') return `apBig(${goString(value as string)})`;
  if (type === 'float') return `float64(${value})`;
  if (type === 'listnode') return `apList([]int{${((value ?? []) as WireValue[]).join(',')}})`;
  if (type === 'treenode') return `apTree([]interface{}{${((value ?? []) as WireValue[]).map(v => v === null ? 'nil' : `int(${v})`).join(',')}})`;
  return String(value);
}
const hasType = (type: ValueType | 'void', wanted: ValueType): boolean => typeof type === 'string' ? type === wanted : hasType('array' in type ? type.array : type.list, wanted);
export function goNodes(adapter: Adapter): string {
  const types = [...adapter.params, adapter.returns];
  return `package main\n${types.some(t => hasType(t, 'listnode')) ? 'type ListNode struct { Val int; Next *ListNode }' : ''}\n${types.some(t => hasType(t, 'treenode')) ? 'type TreeNode struct { Val int; Left, Right *TreeNode }' : ''}\n`;
}
/** Recognize only the leading package clause; never infer or rewrite imports/functions. */
export function goFunctionSource(code: string): string {
  const source = code.startsWith('\uFEFF') ? code.slice(1) : code;
  let position = 0;
  while (position < source.length) {
    const whitespace = /^\s+/.exec(source.slice(position));
    if (whitespace) { position += whitespace[0].length; continue; }
    if (source.startsWith('//', position)) { const end = source.indexOf('\n', position); position = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', position)) { const end = source.indexOf('*/', position + 2); if (end < 0) break; position = end + 2; continue; }
    break;
  }
  if (/^package\b/.test(source.slice(position))) return source;
  return `package main\n//line solution.go:1:1\n${source}`;
}

export function goWrapper(adapter: Adapter, cases: TestCase[]): string {
  const branches = cases.map((test, index) => {
    const declarations = adapter.params.map((type, i) => `a${i} := ${literal(test.args![i], type)}`).join('\n');
    const call = `${adapter.method}(${adapter.params.map((_, i) => `a${i}`).join(',')})`;
    let invoke = `return ${call}`;
    if (adapter.inPlaceArg !== undefined) {
      const span = adapter.inPlaceRange;
      invoke = span ? `${span.end === 'return' ? `used := ${call}` : call}\nreturn apSlice(a${adapter.inPlaceArg}, ${span.start ?? 0}, ${span.end === 'return' ? 'used' : span.end})` : `${call}\nreturn a${adapter.inPlaceArg}`;
    }
    return `case ${index}:\n${declarations}\n${invoke}`;
  }).join('\n');
  const types = [...adapter.params, adapter.returns];
  const list = types.some(t => hasType(t, 'listnode'));
  const tree = types.some(t => hasType(t, 'treenode'));
  return `package main
import ("encoding/json"; "fmt"; "math"; "math/big"; "os"; "reflect"; "runtime/debug"; "strconv"; "unicode/utf8")
type apInvalid struct { message string }; func (e apInvalid) Error() string { return e.message }
type apLimit struct{}; func (apLimit) Error() string { return "Structured result exceeds the task output limit" }
func apBig(value string) *big.Int { out, ok := new(big.Int).SetString(value,10); if !ok { panic(apInvalid{"Invalid big integer"}) }; return out }
func apSlice(value interface{}, start, end int) interface{} { v:=reflect.ValueOf(value); if start<0 || end<start || end>v.Len() {panic(apInvalid{"Invalid in-place effective range"})}; return v.Slice(start,end).Interface() }
${list ? `func apList(values []int) *ListNode { var head *ListNode; for i:=len(values)-1;i>=0;i-- {head=&ListNode{Val:values[i],Next:head}}; return head }
func apListJSON(node *ListNode) []interface{} { out:=[]interface{}{};seen:=map[*ListNode]bool{};for node!=nil {if seen[node]||len(seen)>=10000 {panic(apInvalid{"Cyclic/oversized ListNode output unsupported"})};seen[node]=true;out=append(out,node.Val);node=node.Next};return out }` : ''}
${tree ? `func apTree(values []interface{}) *TreeNode { if len(values)==0||values[0]==nil {return nil};root:=&TreeNode{Val:values[0].(int)};queue:=[]*TreeNode{root};i:=1;for len(queue)>0&&i<len(values) {n:=queue[0];queue=queue[1:];if values[i]!=nil {n.Left=&TreeNode{Val:values[i].(int)};queue=append(queue,n.Left)};i++;if i<len(values) {if values[i]!=nil {n.Right=&TreeNode{Val:values[i].(int)};queue=append(queue,n.Right)};i++}};return root }
func apTreeJSON(node *TreeNode) []interface{} { out:=[]interface{}{};if node==nil{return out};queue:=[]*TreeNode{node};seen:=map[*TreeNode]bool{};for len(queue)>0 {n:=queue[0];queue=queue[1:];if n==nil {out=append(out,nil);continue};if seen[n]||len(seen)>=10000 {panic(apInvalid{"Cyclic/shared/oversized TreeNode output unsupported"})};seen[n]=true;out=append(out,n.Val);queue=append(queue,n.Left,n.Right)};for len(out)>0&&out[len(out)-1]==nil {out=out[:len(out)-1]};return out }` : ''}
func apEncode(value interface{}, kind interface{}) interface{} {
 if collection,ok:=kind.(map[string]interface{});ok {v:=reflect.ValueOf(value);if v.Kind()!=reflect.Slice && v.Kind()!=reflect.Array {panic(apInvalid{"Expected array/list output"})};var child interface{};for _,t:=range collection {child=t};out:=make([]interface{},v.Len());for i:=0;i<v.Len();i++ {out[i]=apEncode(v.Index(i).Interface(),child)};return out}
 switch kind.(string) {
 case "int", "int64": v:=reflect.ValueOf(value);if v.Kind()<reflect.Int||v.Kind()>reflect.Int64 {panic(apInvalid{"Expected integer output"})};n:=v.Int();if kind=="int64" {return strconv.FormatInt(n,10)};if n < -2147483648 || n > 2147483647 {panic(apInvalid{"Expected int32 output"})};return n
 case "bigint": n,ok:=value.(*big.Int);if !ok||n==nil {panic(apInvalid{"Expected big integer output"})};return n.String()
 case "float": v:=reflect.ValueOf(value);if v.Kind()!=reflect.Float32&&v.Kind()!=reflect.Float64 {panic(apInvalid{"Expected float output"})};n:=v.Float();if math.IsNaN(n)||math.IsInf(n,0) {panic(apInvalid{"Nonfinite output"})};return n
 case "boolean": v,ok:=value.(bool);if !ok {panic(apInvalid{"Expected boolean output"})};return v
 case "string": v,ok:=value.(string);if !ok||!utf8.ValidString(v) {panic(apInvalid{"Expected valid UTF-8 string output"})};return v
 case "char": v:=reflect.ValueOf(value);if v.Kind()!=reflect.Uint8||v.Uint()>127 {panic(apInvalid{"Expected one ASCII character output"})};return string([]byte{byte(v.Uint())})
 ${list ? 'case "listnode": n,ok:=value.(*ListNode);if !ok {panic(apInvalid{"Expected ListNode output"})};return apListJSON(n)' : ''}
 ${tree ? 'case "treenode": n,ok:=value.(*TreeNode);if !ok {panic(apInvalid{"Expected TreeNode output"})};return apTreeJSON(n)' : ''}
 };panic(apInvalid{"Unsupported output type"})
}
func apInvoke(index int) interface{} {switch index {${branches}};panic(apInvalid{"Invalid test index"})}
func main() {
 defer func(){if value:=recover();value!=nil {code:="runtime_exception";switch value.(type){case apInvalid:code="invalid_return";case apLimit:code="output_limit"};fmt.Fprintln(os.Stderr,"ALGOPRACTICE_ERROR:"+code+":"+fmt.Sprint(value));os.Stderr.Write(debug.Stack());os.Exit(1)}}()
 index,err:=strconv.Atoi(os.Args[1]);if err!=nil {panic(err)};limit,err:=strconv.Atoi(os.Args[3]);if err!=nil {panic(err)}
 var kind interface{};if err=json.Unmarshal([]byte(${goString(JSON.stringify(observedType(adapter)))}),&kind);err!=nil {panic(err)}
 output,err:=json.Marshal(apEncode(apInvoke(index),kind));if err!=nil {panic(apInvalid{err.Error()})};if len(output)>limit {panic(apLimit{})};if err=os.WriteFile(os.Args[2],output,0600);err!=nil {panic(err)}
}
`;
}
