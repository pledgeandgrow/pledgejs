/**
 * PSX parser — splits .psx files into Rust blocks and TypeScript/JSX.
 *
 * Syntax:
 *   <rust>
 *     // Rust code here
 *   </rust>
 *
 *   // TypeScript/JSX here
 *   export default function Page() { ... }
 *
 * Inline expressions:
 *   const result = await rust! { sqlx::query_scalar!("SELECT 1") };
 *
 * The parser uses a tokenizer-based approach (not regex) for Rust source parsing:
 * 1. Finds all <rust>...</rust> blocks and extracts them (tag-based, safe for regex)
 * 2. Finds all rust!{...} inline expressions and replaces them with variable references
 * 3. Tokenizes Rust source and walks tokens to extract items with accurate line numbers
 * 4. Generates source map entries mapping generated Rust lines → original .psx/.ps lines
 * 5. Returns clean TSX content + structured Rust metadata + source map
 */

import type {
  PSXParseResult,
  RustBlock,
  RustFunction,
  RustParam,
  RustStruct,
  RustField,
  RustEnum,
  RustEnumVariant,
  InlineRustExpr,
  SourceMapEntry,
} from './types';


/**
 * Parses a .psx file content into structured Rust + TSX parts.
 */
export function parsePSX(source: string): PSXParseResult {
  const rustBlocks: RustBlock[] = [];
  const inlineExpressions: InlineRustExpr[] = [];
  const allFunctions: RustFunction[] = [];
  const allStructs: RustStruct[] = [];
  const allEnums: RustEnum[] = [];
  const allImports: string[] = [];
  const sourceMap: SourceMapEntry[] = [];

  // 1. Extract <rust>...</rust> blocks — tag-based extraction is safe with regex
  let tsxContent = source;
  const blockRegex = /<rust>([\s\S]*?)<\/rust>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(source)) !== null) {
    const rustSource = match[1];
    const fullMatch = match[0];

    // Calculate line numbers in the original source
    const startLine = source.slice(0, match.index).split('\n').length - 1;
    const endLine = startLine + fullMatch.split('\n').length - 1;

    const parser = new RustSourceParser(rustSource, startLine);
    const { functions, structs, enums, imports, blockSourceMap } = parser.parse();

    const block: RustBlock = {
      source: rustSource.trim(),
      // `source` is trimmed, so point startLine at its first line (not the
      // <rust> tag line) — codegen and lint map lines as startLine + index.
      startLine: startLine + leadingNewlines(rustSource),
      endLine,
      functions,
      structs,
      enums,
      imports,
      sourceMap: blockSourceMap,
    };

    rustBlocks.push(block);
    allFunctions.push(...functions);
    allStructs.push(...structs);
    allEnums.push(...enums);
    allImports.push(...imports);
    sourceMap.push(...blockSourceMap);
  }

  // Remove <rust> blocks from TSX content
  tsxContent = tsxContent.replace(blockRegex, '');

  // 2. Extract inline rust!{...} expressions — uses brace matching, not regex on Rust
  let inlineIndex = 0;
  // `rust!` must be a standalone token (not the tail of `trust!`/`x.rust!`).
  const inlineRegex = /(?<![\w$.])rust!\s*\{/g;
  let inlineMatch: RegExpExecArray | null;

  while ((inlineMatch = inlineRegex.exec(tsxContent)) !== null) {
    const open = inlineMatch.index + inlineMatch[0].length - 1;
    const close = findMatchingBrace(tsxContent, open);
    if (close === -1) continue; // unbalanced — leave the text untouched
    const varName = `__rust_expr_${inlineIndex}`;

    const inlineExpr: InlineRustExpr = {
      source: tsxContent.slice(open + 1, close).trim(),
      start: inlineMatch.index,
      end: close + 1,
      varName,
    };

    inlineExpressions.push(inlineExpr);
    inlineIndex++;
    inlineRegex.lastIndex = close + 1;
  }

  // Replace inline expressions with variable references. The generated
  // function is async, so `await rust!{…}` becomes `await __rust_expr_N()`
  // (the user's own `await` is preserved as-is).
  let replacedTsx = tsxContent;
  for (let i = inlineExpressions.length - 1; i >= 0; i--) {
    const expr = inlineExpressions[i];
    const replacement = `${expr.varName}()`;
    replacedTsx =
      replacedTsx.slice(0, expr.start) +
      replacement +
      replacedTsx.slice(expr.end);
  }

  // Clean up any leftover empty lines from removed blocks
  replacedTsx = replacedTsx.replace(/^\s*$/gm, '').replace(/\n{3,}/g, '\n\n');

  return {
    tsxContent: replacedTsx.trim(),
    rustBlocks,
    inlineExpressions,
    allFunctions,
    allStructs,
    allEnums,
    allImports,
    hasRust: rustBlocks.length > 0 || inlineExpressions.length > 0,
    sourceMap,
  };
}

/** Number of line breaks before the first non-whitespace character. */
function leadingNewlines(text: string): number {
  const leading = text.match(/^\s*/)?.[0] ?? '';
  return leading.split('\n').length - 1;
}

/**
 * Given the index of an opening `{` in `src`, returns the index of its
 * matching `}` — skipping Rust string/char literals, raw strings and comments
 * — or -1 when unbalanced.
 */
function findMatchingBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      let nest = 1;
      i += 2;
      while (i < src.length && nest > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { nest++; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { nest--; i += 2; }
        else i++;
      }
      continue;
    }
    if (ch === 'r' && (next === '"' || next === '#') && !/[\w$]/.test(src[i - 1] ?? '')) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === '#') { hashes++; j++; }
      if (src[j] === '"') {
        const terminator = '"' + '#'.repeat(hashes);
        const endIdx = src.indexOf(terminator, j + 1);
        if (endIdx === -1) return -1;
        i = endIdx + terminator.length;
        continue;
      }
    }
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '\'') {
      // Char literal ('x', '\n') — otherwise a lifetime, which we skip over.
      if (next === '\\') {
        i += 2;
        while (i < src.length && src[i] !== '\'') i++;
        i++;
        continue;
      }
      if (src[i + 2] === '\'') {
        i += 3;
        continue;
      }
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Parses a .ps file (pure Rust, no TypeScript/JSX).
 *
 * The entire file is treated as one Rust block. No <rust> tags needed,
 * no TSX extraction, no inline expressions. Just plain Rust source code.
 *
 * Usage:
 *   // app/api/users/route.ps
 *   use sqlx::PgPool;
 *
 *   pub async fn get_users(pool: &PgPool) -> Vec<User> {
 *       sqlx::query_as!(User, "SELECT * FROM users").fetch_all(pool).await
 *   }
 *
 * The file is parsed for functions, structs, and enums — same as <rust> blocks.
 * TypeScript types are auto-generated so .tsx files can import and use them.
 */
export function parsePS(source: string): PSXParseResult {
  const parser = new RustSourceParser(source, 0);
  const { functions, structs, enums, imports, blockSourceMap } = parser.parse();

  const block: RustBlock = {
    source: source.trim(),
    startLine: leadingNewlines(source),
    endLine: source.split('\n').length - 1,
    functions,
    structs,
    enums,
    imports,
    sourceMap: blockSourceMap,
  };

  return {
    tsxContent: '',
    rustBlocks: [block],
    inlineExpressions: [],
    allFunctions: functions,
    allStructs: structs,
    allEnums: enums,
    allImports: imports,
    hasRust: true,
    sourceMap: blockSourceMap,
  };
}

// ─── Tokenizer ──────────────────────────────────────────────────────────

interface Token {
  type: 'ident' | 'keyword' | 'symbol' | 'string' | 'number' | 'attr' | 'doc_comment' | 'line_comment' | 'whitespace' | 'newline';
  value: string;
  line: number;
  col: number;
  pos: number;
}

const RUST_KEYWORDS = new Set([
  'fn', 'struct', 'enum', 'use', 'pub', 'async', 'await', 'let', 'mut', 'const',
  'static', 'impl', 'trait', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop',
  'return', 'break', 'continue', 'move', 'ref', 'self', 'Self', 'super', 'crate',
  'as', 'in', 'where', 'dyn', 'unsafe', 'extern', 'type', 'union',
]);

/**
 * Tokenizes Rust source code into a stream of tokens with line/col tracking.
 */
function tokenizeRust(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 0;
  let col = 0;

  while (i < source.length) {
    const ch = source[i];
    const startPos = i;
    const startLine = line;
    const startCol = col;

    // Newline
    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n', line: startLine, col: startCol, pos: startPos });
      line++;
      col = 0;
      i++;
      continue;
    }

    // Whitespace (spaces, tabs)
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      let ws = '';
      while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r')) {
        ws += source[i];
        col++;
        i++;
      }
      tokens.push({ type: 'whitespace', value: ws, line: startLine, col: startCol, pos: startPos });
      continue;
    }

    // Line comment (//)
    if (ch === '/' && source[i + 1] === '/') {
      let comment = '';
      while (i < source.length && source[i] !== '\n') {
        comment += source[i];
        col++;
        i++;
      }
      // Distinguish doc comments (/// or //!)
      const isDoc = comment.startsWith('///') || comment.startsWith('//!');
      tokens.push({
        type: isDoc ? 'doc_comment' : 'line_comment',
        value: comment,
        line: startLine,
        col: startCol,
        pos: startPos,
      });
      continue;
    }

    // Block comment (/* ... */) — with nesting support
    if (ch === '/' && source[i + 1] === '*') {
      let depth = 1;
      let comment = '/*';
      i += 2;
      col += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          comment += '/*';
          i += 2;
          col += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          comment += '*/';
          i += 2;
          col += 2;
        } else {
          if (source[i] === '\n') {
            line++;
            col = 0;
          } else {
            col++;
          }
          comment += source[i];
          i++;
        }
      }
      const isDoc = comment.startsWith('/**') || comment.startsWith('/*!');
      tokens.push({
        type: isDoc ? 'doc_comment' : 'line_comment',
        value: comment,
        line: startLine,
        col: startCol,
        pos: startPos,
      });
      continue;
    }

    // Attribute (#[...])
    if (ch === '#' && source[i + 1] === '[') {
      let attr = '';
      let depth = 0;
      while (i < source.length) {
        if (source[i] === '[') depth++;
        if (source[i] === ']') {
          depth--;
          if (depth === 0) {
            attr += source[i];
            col++;
            i++;
            break;
          }
        }
        if (source[i] === '\n') {
          line++;
          col = 0;
        } else {
          col++;
        }
        attr += source[i];
        i++;
      }
      tokens.push({ type: 'attr', value: attr, line: startLine, col: startCol, pos: startPos });
      continue;
    }

    // String literal ("..." or r"..." or raw strings)
    if (ch === '"' || (ch === 'r' && (source[i + 1] === '"' || source[i + 1] === '#'))) {
      let str = '';
      // Handle raw strings r"..." or r#"..."#
      if (ch === 'r') {
        str += source[i];
        col++;
        i++;
        // Count hash marks
        let hashes = 0;
        while (source[i] === '#') {
          str += source[i];
          col++;
          i++;
          hashes++;
        }
        if (source[i] === '"') {
          str += source[i];
          col++;
          i++;
          // Read until closing " followed by same number of #
          while (i < source.length) {
            if (source[i] === '"') {
              str += source[i];
              col++;
              i++;
              let closeHashes = 0;
              while (closeHashes < hashes && source[i] === '#') {
                str += source[i];
                col++;
                i++;
                closeHashes++;
              }
              if (closeHashes === hashes) break;
            } else {
              if (source[i] === '\n') {
                line++;
                col = 0;
              } else {
                col++;
              }
              str += source[i];
              i++;
            }
          }
        }
      } else {
        // Regular string with escape handling
        str += source[i];
        col++;
        i++;
        while (i < source.length && source[i] !== '"') {
          if (source[i] === '\\' && i + 1 < source.length) {
            str += source[i] + source[i + 1];
            col += 2;
            i += 2;
          } else {
            if (source[i] === '\n') {
              line++;
              col = 0;
            } else {
              col++;
            }
            str += source[i];
            i++;
          }
        }
        if (i < source.length) {
          str += source[i]; // closing "
          col++;
          i++;
        }
      }
      tokens.push({ type: 'string', value: str, line: startLine, col: startCol, pos: startPos });
      continue;
    }

    // Char literal ('x' or '\n') — but NOT a lifetime ('a). A char literal is
    // either an escape sequence or exactly one character followed by a closing
    // quote; anything else is a lifetime and is handled below.
    if (ch === '\'' && (source[i + 1] === '\\' || (i + 2 < source.length && source[i + 2] === '\''))) {
      let str = ch;
      col++;
      i++;
      while (i < source.length && source[i] !== '\'') {
        if (source[i] === '\\' && i + 1 < source.length) {
          str += source[i] + source[i + 1];
          col += 2;
          i += 2;
        } else {
          str += source[i];
          col++;
          i++;
        }
      }
      if (i < source.length) {
        str += source[i];
        col++;
        i++;
      }
      tokens.push({ type: 'string', value: str, line: startLine, col: startCol, pos: startPos });
      continue;
    }

    // Number literal
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < source.length && /[0-9a-fA-FxXoObBeE_\.]/.test(source[i])) {
        num += source[i];
        col++;
        i++;
      }
      tokens.push({ type: 'number', value: num, line: startLine, col: startCol, pos: startPos });
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i])) {
        ident += source[i];
        col++;
        i++;
      }
      // Check for lifetime ('ident)
      if (startCol === 0 && source[startPos] === '\'') {
        // Already handled above
      }
      tokens.push({
        type: RUST_KEYWORDS.has(ident) ? 'keyword' : 'ident',
        value: ident,
        line: startLine,
        col: startCol,
        pos: startPos,
      });
      continue;
    }

    // Lifetime ('ident)
    if (ch === '\'') {
      let lt = ch;
      col++;
      i++;
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i])) {
        lt += source[i];
        col++;
        i++;
      }
      tokens.push({ type: 'symbol', value: lt, line: startLine, col: startCol, pos: startPos });
      continue;
    }

    // Single-character symbols
    tokens.push({ type: 'symbol', value: ch, line: startLine, col: startCol, pos: startPos });
    col++;
    i++;
  }

  return tokens;
}

// ─── Rust Source Parser ──────────────────────────────────────────────────

/**
 * Parser for Rust source code within a <rust> block or .ps file.
 * Uses the tokenizer for accurate item extraction with line tracking.
 */
class RustSourceParser {
  private tokens: Token[];
  private pos = 0;
  private baseLineOffset: number;
  private moduleName: string;

  constructor(source: string, baseLineOffset: number, moduleName = 'unknown') {
    this.tokens = tokenizeRust(source);
    this.baseLineOffset = baseLineOffset;
    this.moduleName = moduleName;
  }

  parse(): {
    functions: RustFunction[];
    structs: RustStruct[];
    enums: RustEnum[];
    imports: string[];
    blockSourceMap: SourceMapEntry[];
  } {
    const functions: RustFunction[] = [];
    const structs: RustStruct[] = [];
    const enums: RustEnum[] = [];
    const imports: string[] = [];
    const blockSourceMap: SourceMapEntry[] = [];

    // Collect pending attributes and doc comments
    let pendingAttrs: string[] = [];
    let pendingDocComments: string[] = [];

    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;

      // Skip whitespace and newlines
      if (token.type === 'whitespace' || token.type === 'newline') {
        this.advance();
        continue;
      }

      // Collect doc comments
      if (token.type === 'doc_comment') {
        const docText = token.value.replace(/^\/\/\/\s*/, '').replace(/^\/\/!\s*/, '').trim();
        pendingDocComments.push(docText);
        this.advance();
        continue;
      }

      // Skip regular comments
      if (token.type === 'line_comment') {
        this.advance();
        continue;
      }

      // Collect attributes
      if (token.type === 'attr') {
        pendingAttrs.push(token.value);
        this.advance();
        continue;
      }

      // Parse use statements
      if (token.type === 'keyword' && token.value === 'use') {
        const importPath = this.parseUseStatement();
        if (importPath) {
          imports.push(importPath);
          blockSourceMap.push({
            generatedLine: -1, // filled during codegen
            originalLine: this.baseLineOffset + token.line,
            moduleName: this.moduleName,
          });
        }
        pendingAttrs = [];
        pendingDocComments = [];
        continue;
      }

      // Items: [pub | pub(...)] [async|unsafe|const|extern "C"]* fn | struct | enum
      let isPub = false;
      let itemToken: Token = token;
      if (token.type === 'keyword' && token.value === 'pub') {
        isPub = true;
        this.advance();
        this.skipWhitespace();
        // pub(crate), pub(super), pub(in path)
        const vis = this.peek();
        if (vis?.type === 'symbol' && vis.value === '(') {
          this.skipBalanced('(', ')');
          this.skipWhitespace();
        }
        const afterPub = this.peek();
        if (!afterPub) continue;
        itemToken = afterPub;
      }

      // Functions, including qualified ones (`pub async fn`, `unsafe fn`, `const fn`, ...)
      if (itemToken.type === 'keyword') {
        const fnInfo = this.findFunctionStart();
        if (fnInfo) {
          const fnLine = this.tokens[fnInfo.fnPos].line;
          this.pos = fnInfo.fnPos;
          const fn = this.parseFunction(isPub, pendingAttrs, pendingDocComments, fnInfo.isAsync);
          if (fn) {
            functions.push(fn);
            blockSourceMap.push({
              generatedLine: -1,
              originalLine: this.baseLineOffset + fnLine,
              moduleName: this.moduleName,
            });
          }
          pendingAttrs = [];
          pendingDocComments = [];
          continue;
        }

        if (itemToken.value === 'struct') {
          const struct = this.parseStruct(isPub, pendingAttrs, pendingDocComments);
          if (struct) {
            structs.push(struct);
            blockSourceMap.push({
              generatedLine: -1,
              originalLine: this.baseLineOffset + itemToken.line,
              moduleName: this.moduleName,
            });
          }
          pendingAttrs = [];
          pendingDocComments = [];
          continue;
        }

        if (itemToken.value === 'enum') {
          const enumDef = this.parseEnum(isPub, pendingAttrs, pendingDocComments);
          if (enumDef) {
            enums.push(enumDef);
            blockSourceMap.push({
              generatedLine: -1,
              originalLine: this.baseLineOffset + itemToken.line,
              moduleName: this.moduleName,
            });
          }
          pendingAttrs = [];
          pendingDocComments = [];
          continue;
        }
      }

      if (isPub) {
        // Other pub items (const, static, trait, mod, ...) — handled by the
        // generic branches below on the next iteration.
        pendingAttrs = [];
        pendingDocComments = [];
        continue;
      }


      // Skip everything else (impl blocks, trait defs, mod, const, etc.)
      // For impl blocks, skip the entire block
      if (token.type === 'keyword' && (token.value === 'impl' || token.value === 'trait' || token.value === 'mod')) {
        this.skipToNextItem();
        pendingAttrs = [];
        pendingDocComments = [];
        continue;
      }

      // Unknown token — skip
      this.advance();
      pendingAttrs = [];
      pendingDocComments = [];
    }

    return { functions, structs, enums, imports, blockSourceMap };
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private advance(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private skipWhitespace(): void {
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (!t || (t.type !== 'whitespace' && t.type !== 'newline')) break;
      this.advance();
    }
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (!t) break;
      if (t.type === 'symbol' && t.value === open) depth++;
      if (t.type === 'symbol' && t.value === close) {
        depth--;
        if (depth === 0) {
          this.advance();
          return;
        }
      }
      this.advance();
    }
  }

  /** Skip until we find the next top-level item (fn, struct, enum, use, impl, etc.) */
  private skipToNextItem(): void {
    // Skip to the opening brace and balance it
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (!t) break;
      if (t.type === 'symbol' && t.value === '{') {
        this.skipBalanced('{', '}');
        return;
      }
      if (t.type === 'symbol' && t.value === ';') {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private parseUseStatement(): string | null {
    // Consume 'use'
    this.advance();
    this.skipWhitespace();

    // Read until ';'
    let path = '';
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (!t) break;
      if (t.type === 'symbol' && t.value === ';') {
        this.advance();
        return path.trim();
      }
      if (t.type !== 'whitespace' && t.type !== 'newline') {
        path += t.value;
      }
      this.advance();
    }
    return path.trim() || null;
  }

  /**
   * Looks ahead from the current position over function qualifiers
   * (`async`, `unsafe`, `const`, `extern "C"`) and reports where the `fn`
   * keyword is, without consuming anything. Returns null if the item at the
   * current position is not a function.
   */
  private findFunctionStart(): { fnPos: number; isAsync: boolean } | null {
    let p = this.pos;
    let isAsync = false;
    let prevWasExtern = false;
    while (p < this.tokens.length) {
      const t = this.tokens[p];
      if (t.type === 'whitespace' || t.type === 'newline') {
        p++;
        continue;
      }
      if (t.type === 'keyword' && t.value === 'fn') return { fnPos: p, isAsync };
      if (t.type === 'keyword' && t.value === 'async') {
        isAsync = true;
      } else if (t.type === 'keyword' && (t.value === 'unsafe' || t.value === 'const')) {
        // qualifier
      } else if (t.type === 'keyword' && t.value === 'extern') {
        prevWasExtern = true;
        p++;
        continue;
      } else if (t.type === 'string' && prevWasExtern) {
        // extern "C"
      } else {
        return null;
      }
      prevWasExtern = false;
      p++;
    }
    return null;
  }

  private parseFunction(
    isPub: boolean,
    attributes: string[],
    docComments: string[],
    isAsync = false,
  ): RustFunction | null {
    // Consume 'fn' (callers position us on it; qualifiers were handled by
    // findFunctionStart, which also determined `isAsync`).
    const fnToken = this.advance();
    if (!fnToken) return null;

    this.skipWhitespace();

    // Function name
    const nameToken = this.peek();
    if (!nameToken || nameToken.type !== 'ident') return null;
    const name = nameToken.value;
    const sourceLine = this.baseLineOffset + nameToken.line;
    this.advance();

    // Skip generics <...>
    this.skipWhitespace();
    const maybeGen = this.peek();
    if (maybeGen?.type === 'symbol' && maybeGen.value === '<') {
      this.skipBalanced('<', '>');
    }

    // Parameters ( ... )
    this.skipWhitespace();
    const parenOpen = this.peek();
    if (!parenOpen || parenOpen.type !== 'symbol' || parenOpen.value !== '(') return null;

    // Extract parameter string by balancing parens
    const paramStart = this.pos;
    this.skipBalanced('(', ')');
    const paramEnd = this.pos;
    const paramTokens = this.tokens.slice(paramStart, paramEnd);
    const paramStr = paramTokens.map((t) => t.value).join('').replace(/^\(/, '').replace(/\)$/, '');
    const params = parseRustParams(paramStr);

    // Return type -> ... or ()
    this.skipWhitespace();
    let returnType = '()';
    const arrow = this.peek();
    if (arrow?.type === 'symbol' && arrow.value === '-' && this.peek(1)?.value === '>') {
      this.advance(); // '-'
      this.advance(); // '>'
      this.skipWhitespace();
      // Read return type until '{' or ';'
      let retType = '';
      while (this.pos < this.tokens.length) {
        const t = this.peek();
        if (!t) break;
        if (t.type === 'symbol' && (t.value === '{' || t.value === ';')) break;
        if (t.type === 'keyword' && t.value === 'where') break;
        if (t.type === 'whitespace' || t.type === 'newline') {
          // Collapse whitespace to a single space so `impl Trait`, `dyn X`
          // and `&mut T` stay separate words.
          if (!retType.endsWith(' ')) retType += ' ';
        } else if (t.type !== 'line_comment' && t.type !== 'doc_comment') {
          retType += t.value;
        }
        this.advance();
      }
      returnType = retType.trim() || '()';
    }

    // Skip where clause if present
    const whereToken = this.peek();
    if (whereToken?.type === 'keyword' && whereToken.value === 'where') {
      // Skip until '{' or ';'
      while (this.pos < this.tokens.length) {
        const t = this.peek();
        if (!t) break;
        if (t.type === 'symbol' && (t.value === '{' || t.value === ';')) break;
        this.advance();
      }
    }

    // Skip the function body { ... } or semicolon (trait method)
    const bodyOrSemi = this.peek();
    if (bodyOrSemi?.type === 'symbol' && bodyOrSemi.value === '{') {
      this.skipBalanced('{', '}');
    } else if (bodyOrSemi?.type === 'symbol' && bodyOrSemi.value === ';') {
      this.advance();
    }

    const returnTypeName = rustTypeToTs(returnType);
    const docComment = docComments.length > 0 ? docComments.join('\n') : undefined;

    return {
      name,
      isAsync,
      isPub,
      params,
      returnType,
      returnTypeName,
      docComment,
      sourceLine,
      attributes: attributes.length > 0 ? attributes : undefined,
    };
  }

  private parseStruct(
    _isPub: boolean,
    attributes: string[],
    docComments: string[],
  ): RustStruct | null {
    // Consume 'struct'
    const structToken = this.advance();
    if (!structToken) return null;

    this.skipWhitespace();

    // Struct name
    const nameToken = this.peek();
    if (!nameToken || nameToken.type !== 'ident') return null;
    const name = nameToken.value;
    const sourceLine = this.baseLineOffset + nameToken.line;
    this.advance();

    // Skip generics <...>
    this.skipWhitespace();
    const maybeGen = this.peek();
    if (maybeGen?.type === 'symbol' && maybeGen.value === '<') {
      this.skipBalanced('<', '>');
    }

    // Skip where clause
    this.skipWhitespace();
    const whereToken = this.peek();
    if (whereToken?.type === 'keyword' && whereToken.value === 'where') {
      while (this.pos < this.tokens.length) {
        const t = this.peek();
        if (!t) break;
        if (t.type === 'symbol' && (t.value === '{' || t.value === ';')) break;
        this.advance();
      }
    }

    // Struct body { ... }
    this.skipWhitespace();
    const braceOpen = this.peek();
    if (!braceOpen || braceOpen.type !== 'symbol' || braceOpen.value !== '{') {
      // Tuple struct: struct Foo(Type1, Type2); or unit struct: struct Foo;
      const semi = this.peek();
      if (semi?.type === 'symbol' && semi.value === ';') {
        this.advance();
        return {
          name,
          fields: [],
          derives: extractDerives(attributes),
          docComment: docComments.length > 0 ? docComments.join('\n') : undefined,
          sourceLine,
          attributes: attributes.length > 0 ? attributes : undefined,
        };
      }
      // Tuple struct
      if (semi?.type === 'symbol' && semi.value === '(') {
        this.skipBalanced('(', ')');
        // Skip to ';'
        while (this.pos < this.tokens.length) {
          const t = this.peek();
          if (!t) break;
          if (t.type === 'symbol' && t.value === ';') { this.advance(); break; }
          this.advance();
        }
        return {
          name,
          fields: [],
          derives: extractDerives(attributes),
          docComment: docComments.length > 0 ? docComments.join('\n') : undefined,
          sourceLine,
          attributes: attributes.length > 0 ? attributes : undefined,
        };
      }
      return null;
    }

    // Extract body by balancing braces
    const bodyStart = this.pos;
    this.skipBalanced('{', '}');
    const bodyEnd = this.pos;
    const bodyTokens = this.tokens.slice(bodyStart, bodyEnd);
    const bodyStr = bodyTokens.map((t) => t.value).join('').replace(/^{/, '').replace(/}$/, '');
    const fields = parseRustFields(bodyStr);

    return {
      name,
      fields,
      derives: extractDerives(attributes),
      docComment: docComments.length > 0 ? docComments.join('\n') : undefined,
      sourceLine,
      attributes: attributes.length > 0 ? attributes : undefined,
    };
  }

  private parseEnum(
    _isPub: boolean,
    attributes: string[],
    docComments: string[],
  ): RustEnum | null {
    // Consume 'enum'
    const enumToken = this.advance();
    if (!enumToken) return null;

    this.skipWhitespace();

    // Enum name
    const nameToken = this.peek();
    if (!nameToken || nameToken.type !== 'ident') return null;
    const name = nameToken.value;
    const sourceLine = this.baseLineOffset + nameToken.line;
    this.advance();

    // Skip generics
    this.skipWhitespace();
    const maybeGen = this.peek();
    if (maybeGen?.type === 'symbol' && maybeGen.value === '<') {
      this.skipBalanced('<', '>');
    }

    // Skip where clause
    this.skipWhitespace();
    const whereToken = this.peek();
    if (whereToken?.type === 'keyword' && whereToken.value === 'where') {
      while (this.pos < this.tokens.length) {
        const t = this.peek();
        if (!t) break;
        if (t.type === 'symbol' && (t.value === '{' || t.value === ';')) break;
        this.advance();
      }
    }

    // Enum body { ... }
    this.skipWhitespace();
    const braceOpen = this.peek();
    if (!braceOpen || braceOpen.type !== 'symbol' || braceOpen.value !== '{') return null;

    const bodyStart = this.pos;
    this.skipBalanced('{', '}');
    const bodyEnd = this.pos;
    const bodyTokens = this.tokens.slice(bodyStart, bodyEnd);
    const bodyStr = bodyTokens.map((t) => t.value).join('').replace(/^{/, '').replace(/}$/, '');

    const variants = parseEnumVariants(bodyStr);

    return {
      name,
      variants,
      derives: extractDerives(attributes),
      docComment: docComments.length > 0 ? docComments.join('\n') : undefined,
      sourceLine,
      attributes: attributes.length > 0 ? attributes : undefined,
    };
  }
}

/** Extract derive macro names from attribute strings */
function extractDerives(attributes: string[]): string[] {
  return attributes
    .filter((a) => a.includes('derive('))
    .flatMap((a) => {
      const match = a.match(/derive\(([^)]*)\)/);
      return match ? match[1].split(',').map((d) => d.trim()).filter(Boolean) : [];
    });
}

interface Range {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits `s` on `sep` at nesting depth 0 (ignoring separators inside <>, (),
 * [] and {}), returning each piece with its offsets. `->` is not treated as
 * closing an angle bracket.
 */
function splitTopLevelRanges(s: string, sep = ','): Range[] {
  const parts: Range[] = [];
  let depth = 0;
  let cur = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '-' && s[i + 1] === '>') {
      cur += '->';
      i++;
      continue;
    }
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) {
      parts.push({ text: cur, start, end: i });
      cur = '';
      start = i + 1;
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push({ text: cur, start, end: s.length });
  return parts;
}

/** Splits on a top-level separator (see splitTopLevelRanges). */
export function splitTopLevel(s: string, sep = ','): string[] {
  return splitTopLevelRanges(s, sep).map((r) => r.text);
}

/**
 * Parses `Name<A, B<C>>` into its base path and top-level type arguments.
 * Returns null when the type is not a generic application.
 */
export function parseGenericType(type: string): { base: string; args: string[] } | null {
  const m = type.trim().match(/^([A-Za-z_][\w:]*)\s*<([\s\S]*)>$/);
  if (!m) return null;
  return { base: m[1], args: splitTopLevel(m[2]).map((a) => a.trim()).filter(Boolean) };
}

/**
 * Removes comments and attributes from a struct/enum body, collecting doc
 * comments together with the offset (into the returned text) of the item
 * they precede.
 */
function stripCommentsAndAttrs(body: string): { text: string; docs: Array<{ offset: number; text: string }> } {
  let text = '';
  const docs: Array<{ offset: number; text: string }> = [];
  for (const rawLine of body.split('\n')) {
    const t = rawLine.trim();
    if (t.startsWith('///')) {
      docs.push({ offset: text.length, text: t.replace(/^\/\/\/\s?/, '').trim() });
      continue;
    }
    if (t.startsWith('//')) continue;
    const line = rawLine
      .replace(/\/\/.*$/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/#\[[^\]]*\]/g, '');
    text += line + '\n';
  }
  return { text, docs };
}

function docFor(docs: Array<{ offset: number; text: string }>, range: Range): string | undefined {
  const matching = docs.filter((d) => d.offset >= range.start && d.offset <= range.end).map((d) => d.text);
  return matching.length > 0 ? matching.join(' ') : undefined;
}

/**
 * Parses Rust enum variants from the body string.
 * Handles unit variants, struct-like variants, and tuple variants.
 */
function parseEnumVariants(body: string): RustEnumVariant[] {
  const variants: RustEnumVariant[] = [];
  const { text, docs } = stripCommentsAndAttrs(body);

  for (const range of splitTopLevelRanges(text)) {
    const variantStr = range.text.trim();
    if (!variantStr) continue;
    const docComment = docFor(docs, range);

    // Struct-like variant: Name { field: Type, ... }
    const structMatch = variantStr.match(/^(\w+)\s*\{([\s\S]*)\}$/);
    if (structMatch) {
      variants.push({
        name: structMatch[1],
        fields: parseRustFields(structMatch[2]),
        docComment,
      });
      continue;
    }

    // Tuple variant: Name(Type1, Type2)
    const tupleMatch = variantStr.match(/^(\w+)\s*\(([\s\S]*)\)$/);
    if (tupleMatch) {
      variants.push({ name: tupleMatch[1], docComment });
      continue;
    }

    // Discriminant: Name = value
    const discMatch = variantStr.match(/^(\w+)\s*=\s*([\s\S]+)/);
    if (discMatch) {
      variants.push({ name: discMatch[1], discriminant: discMatch[2].trim(), docComment });
      continue;
    }

    // Unit variant: just Name
    const nameMatch = variantStr.match(/^(\w+)/);
    if (nameMatch) {
      variants.push({ name: nameMatch[1], docComment });
    }
  }

  return variants;
}

/**
 * Parses Rust function parameters: "pool: &PgPool, limit: i32"
 */
function parseRustParams(paramsStr: string): RustParam[] {
  if (!paramsStr.trim()) return [];
  return splitTopLevel(paramsStr)
    .filter((p) => p.trim())
    .map(parseRustParam);
}

function parseRustParam(paramStr: string): RustParam {
  const trimmed = paramStr.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) {
    // `self`, `&self`, `&mut self`
    if (/\bself$/.test(trimmed)) return { name: 'self', type: 'Self', typeName: 'Self' };
    return { name: trimmed, type: 'unknown', typeName: 'unknown' };
  }
  const name = trimmed.slice(0, colon).trim().replace(/^mut\s+/, '');
  const type = trimmed.slice(colon + 1).trim();
  return { name, type, typeName: rustTypeToTs(type) };
}

/**
 * Parses Rust struct fields: "id: i32, name: String, email: Option<String>"
 * Fields may be separated by commas and/or newlines and may carry doc
 * comments and attributes.
 */
function parseRustFields(body: string): RustField[] {
  const fields: RustField[] = [];
  const { text, docs } = stripCommentsAndAttrs(body);

  for (const range of splitTopLevelRanges(text)) {
    const segment = range.text.trim().replace(/^pub(\([^)]*\))?\s+/, '');
    if (!segment) continue;

    const colon = segment.indexOf(':');
    if (colon === -1) continue;
    const name = segment.slice(0, colon).trim();
    if (!/^(?:r#)?[A-Za-z_]\w*$/.test(name)) continue;
    const type = segment.slice(colon + 1).trim();

    const generic = parseGenericType(type);
    const isOption = !!generic && generic.base.split('::').pop() === 'Option' && generic.args.length === 1;
    const cleanType = isOption ? generic!.args[0] : type;

    fields.push({
      name,
      type: cleanType,
      typeName: rustTypeToTs(cleanType),
      isOption,
      docComment: docFor(docs, range),
    });
  }

  return fields;
}

/**
 * Maps Rust types to TypeScript types.
 */
export function rustTypeToTs(rustType: string): string {
  // Remove lifetimes, references and `mut`
  const type = rustType
    .replace(/&/g, '')
    .replace(/'\w+/g, '')
    .replace(/\bmut\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (type === '()') return 'void';

  const generic = parseGenericType(type);
  if (generic) {
    const name = generic.base.split('::').pop() ?? generic.base;
    const [a, b] = generic.args;
    switch (name) {
      case 'Option':
        if (a !== undefined) return `${rustTypeToTs(a)} | null`;
        break;
      case 'Vec':
      case 'VecDeque':
      case 'HashSet':
      case 'BTreeSet': {
        if (a === undefined) break;
        const inner = rustTypeToTs(a);
        return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
      }
      case 'HashMap':
      case 'BTreeMap':
        if (a !== undefined && b !== undefined) return `Record<${rustTypeToTs(a)}, ${rustTypeToTs(b)}>`;
        break;
      case 'Result': // errors are unwrapped in the binding layer
      case 'Box':
      case 'Arc':
      case 'Rc':
        if (a !== undefined) return rustTypeToTs(a);
        break;
    }
    return type;
  }

  // Tuple (A, B) → [A, B]
  const tupleMatch = type.match(/^\(([\s\S]+)\)$/);
  if (tupleMatch) {
    return `[${splitTopLevel(tupleMatch[1]).map((e) => rustTypeToTs(e.trim())).join(', ')}]`;
  }

  // Slice / array [T] or [T; N] → T[]
  const sliceMatch = type.match(/^\[([\s\S]+?)(?:;[\s\S]*)?\]$/);
  if (sliceMatch) {
    const inner = rustTypeToTs(sliceMatch[1]);
    return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
  }

  // Primitives
  const primitiveMap: Record<string, string> = {
    'i8': 'number',
    'i16': 'number',
    'i32': 'number',
    'i64': 'number',
    'i128': 'number',
    'u8': 'number',
    'u16': 'number',
    'u32': 'number',
    'u64': 'number',
    'u128': 'number',
    'isize': 'number',
    'usize': 'number',
    'f32': 'number',
    'f64': 'number',
    'bool': 'boolean',
    'char': 'string',
    'String': 'string',
    'str': 'string',
  };

  if (primitiveMap[type]) return primitiveMap[type];

  // Custom types (structs/enums) — use the type name as-is
  return type;
}
