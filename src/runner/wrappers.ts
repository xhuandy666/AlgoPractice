import type { Adapter, TestCase, ValueType, WireValue } from './types.ts';
import { pythonDiagnosticPrelude } from './diagnostics.ts';

export const PYTHON_NODES = `
class ListNode:
    def __init__(self, val=0, next=None): self.val, self.next = val, next
class TreeNode:
    def __init__(self, val=0, left=None, right=None): self.val, self.left, self.right = val, left, right
`;
export function pythonWrapper(adapter: Adapter, cases: TestCase[]): string {
  const metadata = Buffer.from(JSON.stringify({ adapter, cases })).toString('base64');
  return `${pythonDiagnosticPrelude('solution.py', 4)}
import sys, json, base64, pathlib, math, collections, typing, runpy
${PYTHON_NODES}
meta = json.loads(base64.b64decode('${metadata}'))
def decode(value, kind):
    if isinstance(kind, dict): return [decode(v, next(iter(kind.values()))) for v in value]
    if kind in ('int64', 'bigint'): return int(value)
    if kind == 'listnode':
        head = None
        for v in reversed(value or []): head = ListNode(v, head)
        return head
    if kind == 'treenode':
        if not value or value[0] is None: return None
        root = TreeNode(value[0]); queue = collections.deque([root]); i = 1
        while queue and i < len(value):
            node = queue.popleft()
            for field in ('left', 'right'):
                if i >= len(value): break
                v = value[i]; i += 1
                if v is not None:
                    child = TreeNode(v); setattr(node, field, child); queue.append(child)
        if any(v is not None for v in value[i:]): raise ValueError('Unreachable tree input')
        return root
    return value
def encode(value, kind):
    if isinstance(kind, dict): return [encode(v, next(iter(kind.values()))) for v in value]
    if kind in ('int64', 'bigint'):
        if not isinstance(value, int) or isinstance(value, bool): raise _APInvalidReturnError('Expected integer output')
        return str(value)
    if kind == 'listnode':
        result = []; seen = set()
        while value is not None:
            if id(value) in seen or len(result) >= 10000: raise _APInvalidReturnError('Cyclic/oversized ListNode output unsupported')
            seen.add(id(value)); result.append(value.val); value = value.next
        return result
    if kind == 'treenode':
        if value is None: return []
        result = []; queue = collections.deque([value]); seen = set()
        while queue:
            node = queue.popleft()
            if node is None: result.append(None); continue
            if id(node) in seen or len(seen) >= 10000: raise _APInvalidReturnError('Cyclic/shared/oversized TreeNode output unsupported')
            seen.add(id(node)); result.append(node.val); queue.extend([node.left, node.right])
        while result and result[-1] is None: result.pop()
        return result
    return value
scope = {'ListNode': ListNode, 'TreeNode': TreeNode, **vars(typing)}
code = pathlib.Path('solution.py').read_text(encoding='utf-8')
exec(compile(code, 'solution.py', 'exec'), scope)
adapter = meta['adapter']; case = meta['cases'][int(sys.argv[1])]
args = [decode(v, t) for v, t in zip(case['args'], adapter['params'])]
result = getattr(scope['Solution'](), adapter['method'])(*args)
if 'inPlaceArg' in adapter:
    kind = adapter['params'][adapter['inPlaceArg']]; observed = args[adapter['inPlaceArg']]
    if 'inPlaceRange' in adapter:
        span = adapter['inPlaceRange']; start = span.get('start', 0); end = result if span['end'] == 'return' else span['end']
        if not isinstance(end, int) or isinstance(end, bool) or end < start or end > len(observed): raise _APInvalidReturnError('Invalid in-place effective range')
        observed = observed[start:end]
    result = observed
else: kind = adapter['returns']
try: encoded = json.dumps(encode(result, kind), ensure_ascii=False, allow_nan=False, separators=(',', ':'))
except (TypeError,ValueError,OverflowError) as error: raise _APInvalidReturnError(str(error)) from error
if len(encoded.encode('utf-8')) > int(sys.argv[3]): raise _APOutputLimitError('Structured result exceeds output limit')
pathlib.Path(sys.argv[2]).write_text(encoded, encoding='utf-8')
`;
}

function javaType(type: ValueType, boxed = false): string {
  if (typeof type !== 'string') return 'array' in type ? `${javaType(type.array)}[]` : `java.util.List<${javaType(type.list, true)}>`;
  const types = { int: boxed ? 'Integer' : 'int', int64: boxed ? 'Long' : 'long', bigint: 'java.math.BigInteger', float: boxed ? 'Double' : 'double', boolean: boxed ? 'Boolean' : 'boolean', string: 'String', listnode: 'ListNode', treenode: 'TreeNode' };
  return types[type];
}
function javaString(value: string): string { return `new String(java.util.Base64.getDecoder().decode("${Buffer.from(value).toString('base64')}"), java.nio.charset.StandardCharsets.UTF_8)`; }
function javaErasedType(type:ValueType):string {return typeof type==='string'?javaType(type):'array' in type?`${javaErasedType(type.array)}[]`:'java.util.List';}
function literal(value: WireValue, type: ValueType): string {
  if (typeof type !== 'string') {
    const inner = 'array' in type ? type.array : type.list;
    const values = (value as WireValue[]).map(v => literal(v, inner)).join(',');
    return 'array' in type ? `new ${javaErasedType(type)}{${values}}` : `new java.util.ArrayList<${javaType(inner, true)}>(java.util.Arrays.<${javaType(inner,true)}>asList(${values}))`;
  }
  if (type === 'string') return javaString(value as string);
  if (type === 'int64') return `Long.parseLong("${value}")`;
  if (type === 'bigint') return `new java.math.BigInteger("${value}")`;
  if (type === 'float') return `Double.parseDouble("${value}")`;
  if (type === 'listnode') return `list(new int[]{${((value ?? []) as WireValue[]).join(',')}})`;
  if (type === 'treenode') return `tree(new Integer[]{${((value ?? []) as WireValue[]).map(v => v === null ? 'null' : v).join(',')}})`;
  return String(value);
}

export function javaWrapper(adapter: Adapter, cases: TestCase[]): string {
  const branches = cases.map((test, index) => {
    const declarations = adapter.params.map((type, i) => `${javaType(type)} a${i} = ${literal(test.args![i], type)};`).join('\n');
    const call = `new Solution().${adapter.method}(${adapter.params.map((_,i) => `a${i}`).join(',')})`;
    const span=adapter.inPlaceRange;
    const observe=adapter.inPlaceArg===undefined?`return ${call};`:span?
      `${span.end==='return'?`int used=${call};`:`${call};`} return slice(a${adapter.inPlaceArg},${span.start??0},${span.end==='return'?'used':span.end});`:
      `${call}; return a${adapter.inPlaceArg};`;
    return `case ${index}: { ${declarations}\n${observe} }`;
  }).join('\n');
  return `import java.util.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
public class Main {
  static class InvalidReturnException extends RuntimeException { InvalidReturnException(String message){super(message);} }
  static class RunnerOutputLimitException extends RuntimeException { RunnerOutputLimitException(String message){super(message);} }
  @SuppressWarnings({"unchecked","rawtypes"}) static Object invoke(int index) throws Exception { switch(index) { ${branches} default: throw new IllegalArgumentException("Invalid test index"); } }
  static Object slice(Object value,int start,int end){
    boolean array=value.getClass().isArray();int size=array?java.lang.reflect.Array.getLength(value):((List<?>)value).size();
    if(start<0||end<start||end>size)throw new InvalidReturnException("Invalid in-place effective range");
    if(!array)return new ArrayList<>(((List<?>)value).subList(start,end));
    Object out=java.lang.reflect.Array.newInstance(value.getClass().getComponentType(),end-start);System.arraycopy(value,start,out,0,end-start);return out;
  }
  static ListNode list(int[] values) { ListNode head = null; for(int i=values.length-1;i>=0;i--) head = new ListNode(values[i],head); return head; }
  static TreeNode tree(Integer[] values) {
    if(values.length==0 || values[0]==null) return null;
    TreeNode root=new TreeNode(values[0]); ArrayDeque<TreeNode> q=new ArrayDeque<>(); q.add(root); int i=1;
    while(!q.isEmpty() && i<values.length) { TreeNode n=q.remove(); if(values[i]!=null) {n.left=new TreeNode(values[i]);q.add(n.left);} i++; if(i<values.length) {if(values[i]!=null){n.right=new TreeNode(values[i]);q.add(n.right);}i++;} }
    for(;i<values.length;i++) if(values[i]!=null) throw new IllegalArgumentException("Unreachable tree input");
    return root;
  }
  static String quote(String s) {
    StringBuilder b=new StringBuilder("\\\"");
    for(char c:s.toCharArray()) { switch(c) { case '"': b.append("\\\\\\\""); break; case '\\\\': b.append("\\\\\\\\"); break; case '\\n': b.append("\\\\n"); break; case '\\r': b.append("\\\\r"); break; case '\\t': b.append("\\\\t"); break; default: if(c<32) b.append(String.format("\\\\u%04x",(int)c)); else b.append(c); } }
    return b.append('"').toString();
  }
  static String json(Object v) {
    if(v==null) return "null";
    if(v instanceof String || v instanceof Character || v instanceof Long || v instanceof java.math.BigInteger) return quote(v.toString());
    if(v instanceof Double && !Double.isFinite((Double)v)) throw new InvalidReturnException("Nonfinite output");
    if(v instanceof Float && !Float.isFinite((Float)v)) throw new InvalidReturnException("Nonfinite output");
    if(v instanceof Number || v instanceof Boolean) return v.toString();
    if(v instanceof ListNode) { ArrayList<Integer> a=new ArrayList<>(); Set<ListNode> seen=Collections.newSetFromMap(new IdentityHashMap<>()); ListNode n=(ListNode)v; while(n!=null) {if(!seen.add(n)||seen.size()>10000) throw new InvalidReturnException("Cyclic/oversized ListNode output unsupported");a.add(n.val);n=n.next;} return json(a); }
    if(v instanceof TreeNode) { ArrayList<Integer> a=new ArrayList<>(); LinkedList<TreeNode> q=new LinkedList<>(); Set<TreeNode> seen=Collections.newSetFromMap(new IdentityHashMap<>());q.add((TreeNode)v);while(!q.isEmpty()){TreeNode n=q.remove();if(n==null){a.add(null);continue;}if(!seen.add(n)||seen.size()>10000)throw new InvalidReturnException("Cyclic/shared/oversized TreeNode output unsupported");a.add(n.val);q.add(n.left);q.add(n.right);}while(!a.isEmpty()&&a.get(a.size()-1)==null)a.remove(a.size()-1);return json(a); }
    ArrayList<String> parts=new ArrayList<>();
    if(v.getClass().isArray()) {for(int i=0;i<java.lang.reflect.Array.getLength(v);i++)parts.add(json(java.lang.reflect.Array.get(v,i)));}
    else if(v instanceof Iterable<?>) {for(Object item:(Iterable<?>)v)parts.add(json(item));}
    else throw new InvalidReturnException("Unsupported output type");
    return "["+String.join(",",parts)+"]";
  }
  public static void main(String[] args) throws Exception {
    Object result=invoke(Integer.parseInt(args[0]));
    String output=${(adapter.inPlaceArg === undefined ? adapter.returns : adapter.params[adapter.inPlaceArg]) === 'listnode' || (adapter.inPlaceArg === undefined ? adapter.returns : adapter.params[adapter.inPlaceArg]) === 'treenode' ? 'result==null ? "[]" : json(result)' : 'json(result)'};
    byte[] data=output.getBytes(StandardCharsets.UTF_8);
    if(data.length>Integer.parseInt(args[2]))throw new RunnerOutputLimitException("Structured result exceeds output limit");
    Files.write(Path.of(args[1]),data);
  }
}
`;
}
export const JAVA_NODES = `class ListNode { int val; ListNode next; ListNode(){} ListNode(int v){val=v;} ListNode(int v,ListNode n){val=v;next=n;} }
class TreeNode { int val; TreeNode left,right; TreeNode(){} TreeNode(int v){val=v;} TreeNode(int v,TreeNode l,TreeNode r){val=v;left=l;right=r;} }
`;
