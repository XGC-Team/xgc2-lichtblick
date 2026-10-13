'use strict';

// AST input is public API too: do not rely solely on the string parser guard.
module.exports = ast => {
  const pending = [[ast, 0]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop();
    if (depth > 128) throw new SyntaxError('AST nesting exceeds the supported depth');
    if (node && Array.isArray(node.nodes)) {
      for (const child of node.nodes) pending.push([child, depth + 1]);
    }
  }
};
