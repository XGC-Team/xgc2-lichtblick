Fork of micromatch/braces 3.0.3 (MIT), maintained as `@xgc2/braces@3.0.3-xgc.1`.
This is not an upstream 3.0.4 release. Original source and license are retained.

GHSA-vfj7-8cjw-p6xm has no upstream fixed version. The parser rejects excessive
brace and parenthesis nesting before recursive processing. The public compile,
expand and stringify entry points additionally validate direct AST input using
an iterative depth check. This includes cyclic ASTs. Shallow behavior is retained.
The regression test exercises string and AST input; the normal dependency audit
command is unchanged. Yarn installs a checksummed file dependency, not a portal.
