import createDOMPurify from 'dompurify';

// Monaco 0.56 vendors an older copy. Give its hooks a separate, patched instance
// so they cannot mutate the sanitizer used by imported problem statements.
export default createDOMPurify(window);
