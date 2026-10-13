import type { Adapter, TestCase, ValueType, WireValue } from './types.ts';
import { observedType } from './values.ts';

/** Independently authored portable convenience header; not GCC's private header. */
export const CPP_BITS_HEADER = '#pragma once\n' + ['algorithm','array','bitset','cassert','cctype','climits','cmath','cstddef','cstdint','cstdio','cstdlib','cstring','deque','functional','iomanip','iostream','iterator','limits','list','map','memory','numeric','optional','queue','set','sstream','stack','stdexcept','string','tuple','type_traits','unordered_map','unordered_set','utility','vector'].map(header => `#include <${header}>`).join('\n') + '\n';
function cppType(type: ValueType): string {
  if (typeof type !== 'string') return `std::vector<${cppType('array' in type ? type.array : type.list)}>`;
  if (type === 'bigint') throw new Error('C++ portable function adapters do not support bigint');
  return { int: 'int', int64: 'long long', float: 'double', boolean: 'bool', string: 'std::string', char: 'char', listnode: 'ListNode*', treenode: 'TreeNode*' }[type];
}
const cppString = (value: string) => `ap_runner::input({${[...Buffer.from(value, 'utf8')].join(',')}})`;
function literal(value: WireValue, type: ValueType): string {
  if (typeof type !== 'string') return `${cppType(type)}{${(value as WireValue[]).map(v => literal(v, 'array' in type ? type.array : type.list)).join(',')}}`;
  if (type === 'string') return cppString(value as string);
  if (type === 'char') return `char(${(value as string).charCodeAt(0)})`;
  if (type === 'int64') return `std::stoll("${value}")`;
  if (type === 'listnode') return `ap_runner::list({${((value ?? []) as WireValue[]).join(',')}})`;
  if (type === 'treenode') return `ap_runner::tree({${((value ?? []) as WireValue[]).map(v => v === null ? 'std::nullopt' : `std::optional<int>(${v})`).join(',')}})`;
  return String(value);
}
function encode(expression: string, type: ValueType): string {
  if (typeof type !== 'string') return `ap_runner::array(${expression}, [](const auto& item) { return ${encode('item', 'array' in type ? type.array : type.list)}; })`;
  if (type === 'bigint') throw new Error('C++ portable function adapters do not support bigint');
  return `ap_runner::${{ int: 'integer32', int64: 'integer64', float: 'floating', boolean: 'boolean', string: 'quote', char: 'character', listnode: 'listJSON', treenode: 'treeJSON' }[type]}(${expression})`;
}
const hasType = (type: ValueType | 'void', wanted: ValueType): boolean => typeof type === 'string' ? type === wanted : hasType('array' in type ? type.array : type.list, wanted);

export function cppWrapper(adapter: Adapter, cases: TestCase[]): string {
  const types = [...adapter.params, adapter.returns];
  const list = types.some(t => hasType(t, 'listnode'));
  const tree = types.some(t => hasType(t, 'treenode'));
  const branches = cases.map((test, index) => {
    const declarations = adapter.params.map((type, i) => `${cppType(type)} a${i} = ${literal(test.args![i], type)};`).join('\n');
    const call = `Solution().${adapter.method}(${adapter.params.map((_, i) => `a${i}`).join(',')})`;
    let invoke = `auto result = ${call}; return ${encode('result', observedType(adapter))};`;
    if (adapter.inPlaceArg !== undefined) {
      const span = adapter.inPlaceRange;
      invoke = span ? `${span.end === 'return' ? `auto used = ${call};` : `${call};`} auto result = ap_runner::slice(a${adapter.inPlaceArg}, ${span.start ?? 0}, ${span.end === 'return' ? 'used' : span.end}); return ${encode('result', observedType(adapter))};` : `${call}; return ${encode(`a${adapter.inPlaceArg}`, observedType(adapter))};`;
    }
    return `case ${index}: { ${declarations}\n${invoke} }`;
  }).join('\n');
  return `#include <bits/stdc++.h>
#include <fstream>
#include <locale>
${list ? 'struct ListNode { int val; ListNode* next; ListNode(int v=0,ListNode* n=nullptr):val(v),next(n){} };' : ''}
${tree ? 'struct TreeNode { int val; TreeNode *left,*right; TreeNode(int v=0,TreeNode* l=nullptr,TreeNode* r=nullptr):val(v),left(l),right(r){} };' : ''}
namespace ap_runner {
struct Invalid : std::runtime_error { using std::runtime_error::runtime_error; };
struct Limit : std::runtime_error { Limit():std::runtime_error("Structured result exceeds the task output limit"){} };
std::string input(std::initializer_list<unsigned char> bytes) { std::string out; for(auto byte:bytes) out.push_back(static_cast<char>(byte)); return out; }
bool utf8(const std::string& value) {
 for(size_t i=0;i<value.size();) { unsigned char c=value[i++]; if(c<128)continue; int count;unsigned int code;
 if(c>=0xC2&&c<=0xDF){count=1;code=c&31;}else if(c>=0xE0&&c<=0xEF){count=2;code=c&15;}else if(c>=0xF0&&c<=0xF4){count=3;code=c&7;}else return false;
 const int width=count;while(count--){if(i>=value.size())return false;unsigned char next=value[i++];if((next&0xC0)!=0x80)return false;code=(code<<6)|(next&63);}
 if((width==2&&code<0x800)||(width==3&&code<0x10000)||(code>=0xD800&&code<=0xDFFF)||code>0x10FFFF)return false;
 }return true;
}
std::string quote(const std::string& value) {
 if(!utf8(value))throw Invalid("Expected valid UTF-8 string output");std::string out="\\\"";const char* hex="0123456789abcdef";
 for(unsigned char c:value){if(c=='"'||c=='\\\\'){out.push_back('\\\\');out.push_back(c);}else if(c<32){out+="\\\\u00";out.push_back(hex[c>>4]);out.push_back(hex[c&15]);}else out.push_back(c);}out.push_back('"');return out;
}
template<class T> long long checkedInteger(T value) {
 static_assert(std::is_integral_v<T> && !std::is_same_v<T,bool>, "Adapter requires an integer return");
 static_assert(sizeof(T)<=sizeof(long long), "Portable adapters require at most 64-bit integers");
 if constexpr(std::is_unsigned_v<T>){if(value>static_cast<unsigned long long>(std::numeric_limits<long long>::max()))throw Invalid("int64 out of range");}
 return static_cast<long long>(value);
}
template<class T> std::string integer32(T value) {long long n=checkedInteger(value);if(n< -2147483648LL||n>2147483647LL)throw Invalid("Expected int32 output");return std::to_string(n);}
template<class T> std::string integer64(T value) {return quote(std::to_string(checkedInteger(value)));}
template<class T> std::string floating(T value) {static_assert(std::is_floating_point_v<T>, "Adapter requires a floating-point return");if(!std::isfinite(value))throw Invalid("Nonfinite output");std::ostringstream stream;stream.imbue(std::locale::classic());stream<<std::setprecision(std::numeric_limits<T>::max_digits10)<<value;return stream.str();}
template<class T> std::string boolean(T value) {static_assert(std::is_same_v<T,bool>, "Adapter requires a boolean return");return value?"true":"false";}
template<class T> std::string character(T value) {static_assert(std::is_same_v<T,char>||std::is_same_v<T,unsigned char>||std::is_same_v<T,signed char>, "Adapter requires a character return");unsigned char byte=static_cast<unsigned char>(value);if(byte>127)throw Invalid("Expected one ASCII character output");return quote(std::string(1,static_cast<char>(byte)));}
template<class T,class Encode> std::string array(const std::vector<T>& values,Encode encode) {std::string out="[";for(size_t i=0;i<values.size();i++){if(i)out+=",";if constexpr(std::is_same_v<T,bool>)out+=encode(static_cast<bool>(values[i]));else out+=encode(values[i]);}return out+"]";}
template<class T,class End> std::vector<T> slice(const std::vector<T>& values,int start,End endValue) {long long end=checkedInteger(endValue);if(start<0||end<start||static_cast<unsigned long long>(end)>values.size())throw Invalid("Invalid in-place effective range");return std::vector<T>(values.begin()+start,values.begin()+static_cast<size_t>(end));}
${list ? `ListNode* list(std::initializer_list<int> values) {ListNode* head=nullptr;auto it=values.end();while(it!=values.begin()){--it;head=new ListNode(*it,head);}return head;}
std::string listJSON(ListNode* node) {std::vector<int> values;std::unordered_set<ListNode*> seen;while(node){if(!seen.insert(node).second||seen.size()>10000)throw Invalid("Cyclic/oversized ListNode output unsupported");values.push_back(node->val);node=node->next;}return array(values,[](int value){return integer32(value);});}` : ''}
${tree ? `TreeNode* tree(std::initializer_list<std::optional<int>> inputValues) {std::vector<std::optional<int>> values(inputValues);if(values.empty()||!values[0])return nullptr;TreeNode* root=new TreeNode(*values[0]);std::queue<TreeNode*> queue;queue.push(root);size_t i=1;while(!queue.empty()&&i<values.size()){TreeNode* n=queue.front();queue.pop();if(values[i]){n->left=new TreeNode(*values[i]);queue.push(n->left);}i++;if(i<values.size()){if(values[i]){n->right=new TreeNode(*values[i]);queue.push(n->right);}i++;}}return root;}
std::string treeJSON(TreeNode* node) {std::vector<std::optional<int>> values;if(!node)return "[]";std::queue<TreeNode*> queue;std::unordered_set<TreeNode*> seen;queue.push(node);while(!queue.empty()){TreeNode* n=queue.front();queue.pop();if(!n){values.push_back(std::nullopt);continue;}if(!seen.insert(n).second||seen.size()>10000)throw Invalid("Cyclic/shared/oversized TreeNode output unsupported");values.push_back(n->val);queue.push(n->left);queue.push(n->right);}while(!values.empty()&&!values.back())values.pop_back();return array(values,[](const std::optional<int>& value){return value?integer32(*value):"null";});}` : ''}
}
using namespace std;
#include "solution.cpp"
namespace ap_runner {
std::string invoke(int index) {switch(index) {${branches}};throw Invalid("Invalid test index");}
}
int main(int argc,char** argv) {
 try {if(argc!=4)throw std::runtime_error("Generated wrapper arguments are invalid");std::string output=ap_runner::invoke(std::stoi(argv[1]));if(output.size()>std::stoull(argv[3]))throw ap_runner::Limit();std::ofstream file(argv[2],std::ios::binary);file.exceptions(std::ios::failbit|std::ios::badbit);file.write(output.data(),static_cast<std::streamsize>(output.size()));}
 catch(const ap_runner::Limit& error){std::cerr<<"ALGOPRACTICE_ERROR:output_limit:"<<error.what()<<"\\n";return 1;}
 catch(const ap_runner::Invalid& error){std::cerr<<"ALGOPRACTICE_ERROR:invalid_return:"<<error.what()<<"\\n";return 1;}
 catch(const std::exception& error){std::cerr<<"ALGOPRACTICE_ERROR:runtime_exception:"<<error.what()<<"\\n";return 1;}
 catch(...){std::cerr<<"ALGOPRACTICE_ERROR:runtime_exception:Unknown C++ exception\\n";return 1;}
}
`;
}
