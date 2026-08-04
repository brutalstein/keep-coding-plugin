(function_definition
  declarator: (function_declarator) @symbol.function.declarator) @symbol.function.definition

(declaration
  declarator: (function_declarator) @symbol.function.declarator) @symbol.function.declaration

(struct_specifier
  name: (type_identifier) @symbol.struct.name) @symbol.struct.definition

(union_specifier
  name: (type_identifier) @symbol.union.name) @symbol.union.definition

(enum_specifier
  name: (type_identifier) @symbol.enum.name) @symbol.enum.definition

(preproc_include
  path: (_) @import.path) @import.statement

(call_expression
  function: (_) @reference.call.target) @reference.call
