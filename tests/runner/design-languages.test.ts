import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { defaultRuntimePath, runCode } from '../../src/runner/index.ts';
import type { DesignAdapter, Language, RunResult, TestCase, WireValue } from '../../src/runner/types.ts';
import { designAdapter, designSampleArguments, designStatementOutputs } from '../../src/source/problem-content.ts';
import { designCaseKey } from '../../src/runner/design.ts';

// Real toolchains only: ALGOPRACTICE_NATIVE_TEST_ROOT holds python/ and java/ (and optionally go/, cpp/);
// ALGOPRACTICE_GO_TEST_PATH / ALGOPRACTICE_CPP_TEST_PATH may point at system Go / C++ compilers instead.
const root = process.env.ALGOPRACTICE_NATIVE_TEST_ROOT ? path.resolve(process.env.ALGOPRACTICE_NATIVE_TEST_ROOT) : undefined;
const runtimePath = (language: Language) => language === 'go' ? process.env.ALGOPRACTICE_GO_TEST_PATH ?? defaultRuntimePath('go', root)
  : language === 'cpp' ? process.env.ALGOPRACTICE_CPP_TEST_PATH ?? defaultRuntimePath('cpp', root) : defaultRuntimePath(language, root);
const available = async (language: Language) => Boolean(root) && await access(runtimePath(language)).then(() => true, () => false);

type Fixture = { metaData: string; exampleTestcases: string; jsonExampleTestcases: string; exampleHtml: string };
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/leetcode-design.json', import.meta.url), 'utf8')) as Record<string, Fixture>;
/** The fixture's sample case with the statement's own output as the expected value. */
function problem(slug: string): { adapter: DesignAdapter; cases: TestCase[] } {
  const adapter = designAdapter(JSON.parse(fixtures[slug].metaData))!;
  const outputs = designStatementOutputs(fixtures[slug].exampleHtml, adapter);
  return { adapter, cases: designSampleArguments(fixtures[slug] as never, adapter).map(args => ({ args, expected: outputs.get(designCaseKey(args, adapter))! })) };
}

const solutions: Record<Language, Record<string, string>> = {
  python: {
    'lru-cache': `from collections import OrderedDict
class LRUCache:
    def __init__(self, capacity: int):
        self.capacity, self.items = capacity, OrderedDict()
    def get(self, key: int) -> int:
        if key not in self.items: return -1
        self.items.move_to_end(key)
        return self.items[key]
    def put(self, key: int, value: int) -> None:
        self.items[key] = value
        self.items.move_to_end(key)
        if len(self.items) > self.capacity: self.items.popitem(last=False)
`,
    'min-stack': `class MinStack:
    def __init__(self):
        self.stack = []
    def push(self, value: int) -> None:
        self.stack.append((value, min(value, self.stack[-1][1]) if self.stack else value))
    def pop(self) -> None:
        self.stack.pop()
    def top(self) -> int:
        return self.stack[-1][0]
    def getMin(self) -> int:
        return self.stack[-1][1]
`,
    'implement-trie-prefix-tree': `class Trie:
    def __init__(self):
        self.words = set()
    def insert(self, word: str) -> None:
        self.words.add(word)
    def search(self, word: str) -> bool:
        return word in self.words
    def startsWith(self, prefix: str) -> bool:
        return any(word.startswith(prefix) for word in self.words)
`,
    'find-median-from-data-stream': `class MedianFinder:
    def __init__(self):
        self.values = []
    def addNum(self, num: int) -> None:
        self.values.append(num); self.values.sort()
    def findMedian(self) -> float:
        n = len(self.values)
        return self.values[n // 2] if n % 2 else (self.values[n // 2 - 1] + self.values[n // 2]) / 2
`,
  },
  java: {
    'lru-cache': `class LRUCache {
    private final int capacity; private final LinkedHashMap<Integer, Integer> items = new LinkedHashMap<>(16, 0.75f, true);
    public LRUCache(int capacity) { this.capacity = capacity; }
    public int get(int key) { return items.getOrDefault(key, -1); }
    public void put(int key, int value) { items.put(key, value); if (items.size() > capacity) items.remove(items.keySet().iterator().next()); }
}`,
    'min-stack': `class MinStack {
    private final Deque<int[]> stack = new ArrayDeque<>();
    public MinStack() {}
    public void push(int value) { stack.push(new int[]{value, stack.isEmpty() ? value : Math.min(value, stack.peek()[1])}); }
    public void pop() { stack.pop(); }
    public int top() { return stack.peek()[0]; }
    public int getMin() { return stack.peek()[1]; }
}`,
    'implement-trie-prefix-tree': `class Trie {
    private final TreeSet<String> words = new TreeSet<>();
    public Trie() {}
    public void insert(String word) { words.add(word); }
    public boolean search(String word) { return words.contains(word); }
    public boolean startsWith(String prefix) { String next = words.ceiling(prefix); return next != null && next.startsWith(prefix); }
}`,
    'find-median-from-data-stream': `class MedianFinder {
    private final PriorityQueue<Integer> low = new PriorityQueue<>(Collections.reverseOrder()), high = new PriorityQueue<>();
    public MedianFinder() {}
    public void addNum(int num) { low.add(num); high.add(low.poll()); if (high.size() > low.size()) low.add(high.poll()); }
    public double findMedian() { return low.size() > high.size() ? low.peek() : (low.peek() + high.peek()) / 2.0; }
}`,
  },
  go: {
    'lru-cache': `import "container/list"
type entry struct{ key, value int }
type LRUCache struct { capacity int; order *list.List; items map[int]*list.Element }
func Constructor(capacity int) LRUCache { return LRUCache{capacity, list.New(), map[int]*list.Element{}} }
func (this *LRUCache) Get(key int) int { if e, ok := this.items[key]; ok { this.order.MoveToFront(e); return e.Value.(entry).value }; return -1 }
func (this *LRUCache) Put(key int, value int) {
    if e, ok := this.items[key]; ok { e.Value = entry{key, value}; this.order.MoveToFront(e); return }
    this.items[key] = this.order.PushFront(entry{key, value})
    if this.order.Len() > this.capacity { last := this.order.Back(); this.order.Remove(last); delete(this.items, last.Value.(entry).key) }
}`,
    'min-stack': `type MinStack struct { stack [][2]int }
func Constructor() MinStack { return MinStack{} }
func (this *MinStack) Push(value int) { m := value; if n := len(this.stack); n > 0 && this.stack[n-1][1] < m { m = this.stack[n-1][1] }; this.stack = append(this.stack, [2]int{value, m}) }
func (this *MinStack) Pop() { this.stack = this.stack[:len(this.stack)-1] }
func (this *MinStack) Top() int { return this.stack[len(this.stack)-1][0] }
func (this *MinStack) GetMin() int { return this.stack[len(this.stack)-1][1] }`,
    'implement-trie-prefix-tree': `import "strings"
type Trie struct { words map[string]bool }
func Constructor() Trie { return Trie{map[string]bool{}} }
func (this *Trie) Insert(word string) { this.words[word] = true }
func (this *Trie) Search(word string) bool { return this.words[word] }
func (this *Trie) StartsWith(prefix string) bool { for w := range this.words { if strings.HasPrefix(w, prefix) { return true } }; return false }`,
    'find-median-from-data-stream': `import "sort"
type MedianFinder struct { values []int }
func Constructor() MedianFinder { return MedianFinder{} }
func (this *MedianFinder) AddNum(num int) { this.values = append(this.values, num); sort.Ints(this.values) }
func (this *MedianFinder) FindMedian() float64 { n := len(this.values); if n%2 == 1 { return float64(this.values[n/2]) }; return float64(this.values[n/2-1]+this.values[n/2]) / 2 }`,
  },
  cpp: {
    'lru-cache': `class LRUCache {
    int capacity; list<pair<int, int>> order; unordered_map<int, list<pair<int, int>>::iterator> items;
public:
    LRUCache(int capacity) : capacity(capacity) {}
    int get(int key) { auto it = items.find(key); if (it == items.end()) return -1; order.splice(order.begin(), order, it->second); return it->second->second; }
    void put(int key, int value) {
        auto it = items.find(key); if (it != items.end()) { it->second->second = value; order.splice(order.begin(), order, it->second); return; }
        order.emplace_front(key, value); items[key] = order.begin();
        if ((int)order.size() > capacity) { items.erase(order.back().first); order.pop_back(); }
    }
};`,
    'min-stack': `class MinStack {
    vector<int> values, mins;
public:
    MinStack() {}
    void push(int value) { values.push_back(value); mins.push_back(mins.empty() ? value : min(value, mins.back())); }
    void pop() { values.pop_back(); mins.pop_back(); }
    int top() { return values.back(); }
    int getMin() { return mins.back(); }
};`,
    'implement-trie-prefix-tree': `class Trie {
    set<string> words;
public:
    Trie() {}
    void insert(string word) { words.insert(word); }
    bool search(string word) { return words.count(word) > 0; }
    bool startsWith(string prefix) { auto it = words.lower_bound(prefix); return it != words.end() && it->compare(0, prefix.size(), prefix) == 0; }
};`,
    'find-median-from-data-stream': `class MedianFinder {
    priority_queue<int> low; priority_queue<int, vector<int>, greater<int>> high;
public:
    MedianFinder() {}
    void addNum(int num) { low.push(num); high.push(low.top()); low.pop(); if (high.size() > low.size()) { low.push(high.top()); high.pop(); } }
    double findMedian() { return low.size() > high.size() ? low.top() : (low.top() + high.top()) / 2.0; }
};`,
  },
};

// A synthetic class covering what the Hot100 examples do not: an array constructor argument (a non-const reference in
// C++), array/string/int64 returns (int64 beyond 2^53), list and tree parameters, a quoted string, and more than 100
// calls in one case (Java splits calls into helper methods of 100).
const bag: DesignAdapter = { kind: 'design', className: 'Bag', constructorParams: [{ array: 'int' }], methods: [
  { name: 'add', params: ['int'], returns: 'void' }, { name: 'extend', params: [{ array: 'int' }], returns: 'void' },
  { name: 'snapshot', params: [], returns: { array: 'int' } }, { name: 'label', params: ['string'], returns: 'string' },
  { name: 'total', params: [], returns: 'int64' }, { name: 'sumList', params: ['listnode'], returns: 'int' }, { name: 'depth', params: ['treenode'], returns: 'int' }] };
function bagCase(): TestCase {
  const operations: string[] = ['Bag'], args: WireValue[][] = [[[1, 2, 3]]], expected: WireValue[] = [null], values = [1, 2, 3];
  const step = (operation: string, call: WireValue[], result: WireValue) => { operations.push(operation); args.push(call); expected.push(result); };
  for (let i = 0; i < 120; i++) { step('add', [i % 7 - 3], null); values.push(i % 7 - 3); }
  step('extend', [[5, 6]], null); values.push(5, 6);
  step('snapshot', [], [...values]); step('label', ['n"ame'], `n"ame:${values.length}`);
  step('total', [], (BigInt(values.reduce((a, b) => a + b, 0)) * 1_000_000_000_000_000n).toString());
  step('sumList', [[1, 2, 3]], 6); step('sumList', [[]], 0); step('depth', [[1, 2, null, 3]], 3); step('depth', [[]], 0);
  for (let i = 0; i < 25; i++) { step('add', [i], null); values.push(i); }
  step('snapshot', [], [...values]);
  return { args: [operations, args], expected };
}
const bagSolutions: Record<Language, string> = {
  python: `class Bag:
    def __init__(self, initial: List[int]):
        self.values = list(initial)
    def add(self, value: int) -> None:
        self.values.append(value)
    def extend(self, more: List[int]) -> None:
        self.values.extend(more)
    def snapshot(self) -> List[int]:
        return list(self.values)
    def label(self, name: str) -> str:
        return f'{name}:{len(self.values)}'
    def total(self) -> int:
        return sum(self.values) * 1000000000000000
    def sumList(self, head: Optional[ListNode]) -> int:
        total = 0
        while head: total, head = total + head.val, head.next
        return total
    def depth(self, root: Optional[TreeNode]) -> int:
        return 1 + max(self.depth(root.left), self.depth(root.right)) if root else 0
`,
  java: `class Bag {
    private final List<Integer> values = new ArrayList<>();
    public Bag(int[] initial) { for (int value : initial) values.add(value); }
    public void add(int value) { values.add(value); }
    public void extend(int[] more) { for (int value : more) values.add(value); }
    public int[] snapshot() { return values.stream().mapToInt(Integer::intValue).toArray(); }
    public String label(String name) { return name + ":" + values.size(); }
    public long total() { long sum = 0; for (int value : values) sum += value; return sum * 1000000000000000L; }
    public int sumList(ListNode head) { int sum = 0; for (; head != null; head = head.next) sum += head.val; return sum; }
    public int depth(TreeNode root) { return root == null ? 0 : 1 + Math.max(depth(root.left), depth(root.right)); }
}`,
  go: `import "strconv"
type Bag struct { values []int }
func Constructor(initial []int) Bag { return Bag{append([]int{}, initial...)} }
func (this *Bag) Add(value int) { this.values = append(this.values, value) }
func (this *Bag) Extend(more []int) { this.values = append(this.values, more...) }
func (this *Bag) Snapshot() []int { return append([]int{}, this.values...) }
func (this *Bag) Label(name string) string { return name + ":" + strconv.Itoa(len(this.values)) }
func (this *Bag) Total() int64 { var sum int64; for _, v := range this.values { sum += int64(v) }; return sum * 1000000000000000 }
func (this *Bag) SumList(head *ListNode) int { sum := 0; for ; head != nil; head = head.Next { sum += head.Val }; return sum }
func (this *Bag) Depth(root *TreeNode) int { if root == nil { return 0 }; l, r := this.Depth(root.Left), this.Depth(root.Right); if l > r { return l + 1 }; return r + 1 }`,
  cpp: `class Bag {
    vector<int> values;
public:
    Bag(vector<int>& initial) : values(initial) {}
    void add(int value) { values.push_back(value); }
    void extend(vector<int>& more) { values.insert(values.end(), more.begin(), more.end()); }
    vector<int> snapshot() { return values; }
    string label(string name) { return name + ":" + to_string(values.size()); }
    long long total() { long long sum = 0; for (int value : values) sum += value; return sum * 1000000000000000LL; }
    int sumList(ListNode* head) { int sum = 0; for (; head; head = head->next) sum += head->val; return sum; }
    int depth(TreeNode* root) { return root ? 1 + max(depth(root->left), depth(root->right)) : 0; }
};`,
};

async function run(language: Language, slug: string, code: string, cases?: TestCase[]): Promise<RunResult> {
  const { adapter, cases: samples } = problem(slug);
  return runCode({ language, runtimePath: runtimePath(language), code, mode: 'function', adapter, cases: cases ?? samples }, { runtimeRoot: root });
}

for (const language of ['python', 'java', 'go', 'cpp'] as const) {
  const skip = await available(language) ? false : 'Set ALGOPRACTICE_NATIVE_TEST_ROOT (and GO/CPP_TEST_PATH) to prepared toolchains.';
  for (const slug of Object.keys(fixtures)) {
    test(`${language}: design ${slug} passes the statement example`, { skip }, async () => {
      const result = await run(language, slug, solutions[language][slug]);
      assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics.length ? result.diagnostics : result.caseResults, null, 1));
    });
  }
  test(`${language}: design outputs are observed per operation and wrong values are reported`, { skip }, async () => {
    // getMin always answers 0.
    const wrong = solutions[language]['min-stack'].replace(/return ([^\n;]*)\[1\]/, 'return 0 * $1[1]').replace(/return mins\.back\(\)/, 'return 0');
    assert.notEqual(wrong, solutions[language]['min-stack'], 'the wrong variant must differ');
    const result = await run(language, 'min-stack', wrong);
    assert.equal(result.status, 'wrong_answer');
    assert.deepEqual(result.caseResults[0].actual, [null, null, null, null, 0, null, 0, 0]);
    const unjudged = await run(language, 'lru-cache', solutions[language]['lru-cache'], [{ args: [['LRUCache', 'put', 'get', 'get'], [[1], [7, 70], [7], [8]]] }]);
    assert.equal(unjudged.status, 'completed'); assert.deepEqual(unjudged.caseResults[0].actual, [null, null, 70, -1]);
  });
  test(`${language}: arrays, strings, int64, list and tree arguments and long cases run through the design driver`, { skip }, async () => {
    const test = bagCase();
    const result = await runCode({ language, runtimePath: runtimePath(language), code: bagSolutions[language], mode: 'function', adapter: bag, cases: [test] }, { runtimeRoot: root });
    assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics.length ? result.diagnostics : result.caseResults[0]?.actual));
    assert.equal((test.args![0] as string[]).length > 150, true);
  });
  test(`${language}: an exception inside a design method is the user's runtime error`, { skip }, async () => {
    const top = { python: ['return self.stack[-1][0]', "raise ValueError('boom')"], java: ['return stack.peek()[0];', 'throw new IllegalStateException("boom");'],
      go: ['return this.stack[len(this.stack)-1][0]', 'panic("boom")'], cpp: ['return values.back();', 'throw std::runtime_error("boom");'] }[language];
    const failing = solutions[language]['min-stack'].replace(top[0], top[1]);
    assert.notEqual(failing, solutions[language]['min-stack']);
    const result = await run(language, 'min-stack', failing);
    assert.equal(result.status, 'runtime_error', JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.source === 'user' && /boom/.test(diagnostic.message)), JSON.stringify(result.diagnostics));
  });
}
