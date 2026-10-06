import { StreamLanguage, type StreamParser } from '@codemirror/language';

type StringState = { delimiter: string | null };

function consumeQuoted(stream: Parameters<StreamParser<StringState>['token']>[0], state: StringState): string {
  const delimiter = state.delimiter!;
  while (!stream.eol()) {
    if (stream.match(delimiter)) {
      state.delimiter = null;
      break;
    }
    if (stream.next() === '\\') stream.next();
  }
  return 'string';
}

const gdscriptMode: StreamParser<StringState> = {
  name: 'gdscript',
  startState: () => ({ delimiter: null }),
  token(stream, state) {
    if (state.delimiter) return consumeQuoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match(/#.*/)) return 'comment';
    if (stream.match(/"""|'''|"|'/)) {
      state.delimiter = stream.current();
      return consumeQuoted(stream, state);
    }
    if (stream.match(/@[A-Za-z_][\w]*/)) return 'meta';
    if (stream.match(/(?:\$|%)(?:[A-Za-z_][\w]*|"[^"]+")(?:\/[A-Za-z_][\w]*)*/)) return 'variableName.special';
    if (stream.match(/\b(?:extends|class_name|func|static|var|const|enum|signal|if|elif|else|for|while|match|when|return|break|continue|pass|await|in|is|as|and|or|not|assert|breakpoint|self|super)\b/)) return 'keyword';
    if (stream.match(/\b(?:true|false|null|PI|TAU|INF|NAN)\b/)) return 'atom';
    if (stream.match(/\b(?:int|float|bool|String|StringName|Vector2|Vector2i|Vector3|Vector3i|Color|Node|Node2D|Node3D|Control|Array|Dictionary|Callable|Signal|Variant|void)\b/)) return 'typeName';
    if (stream.match(/\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b/)) return 'number';
    if (stream.match(/[A-Za-z_][\w]*/)) return 'variableName';
    if (stream.match(/(?:==|!=|<=|>=|->|:=|\+=|-=|\*=|\/=|\*\*|&&|\|\||[+*/%=<>!&|^~-]+)/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
};

const resourceMode: StreamParser<StringState> = {
  name: 'godot-resource',
  startState: () => ({ delimiter: null }),
  token(stream, state) {
    if (state.delimiter) return consumeQuoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match(/;.*/) || stream.match(/#.*/)) return 'comment';
    if (stream.match(/\[[^\]]*\]/)) return 'heading';
    if (stream.match(/"""|"|'/)) {
      state.delimiter = stream.current();
      return consumeQuoted(stream, state);
    }
    if (stream.match(/\b(?:ExtResource|SubResource|Resource|NodePath|PackedStringArray|Vector2|Vector3|Color|Transform2D|Transform3D)\b/)) return 'typeName';
    if (stream.match(/\b(?:true|false|null)\b/)) return 'atom';
    if (stream.match(/\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/)) return 'number';
    if (stream.match(/[A-Za-z_][\w/]*/)) return 'propertyName';
    if (stream.match(/[=(),]/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ';' } },
};

const shaderMode: StreamParser<StringState> = {
  name: 'gdshader',
  startState: () => ({ delimiter: null }),
  token(stream, state) {
    if (state.delimiter) return consumeQuoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match(/\/\/.*/)) return 'comment';
    if (stream.match(/"/)) {
      state.delimiter = '"';
      return consumeQuoted(stream, state);
    }
    if (stream.match(/\b(?:shader_type|render_mode|uniform|varying|const|void|if|else|for|while|return|discard|in|out|inout)\b/)) return 'keyword';
    if (stream.match(/\b(?:float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|mat2|mat3|mat4|sampler2D|samplerCube)\b/)) return 'typeName';
    if (stream.match(/\b\d+(?:\.\d+)?\b/)) return 'number';
    if (stream.match(/[A-Za-z_][\w]*/)) return 'variableName';
    if (stream.match(/[+*/%=<>!&|^~-]+/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
};

export function gdscript() { return StreamLanguage.define(gdscriptMode); }
export function godotResource() { return StreamLanguage.define(resourceMode); }
export function gdshader() { return StreamLanguage.define(shaderMode); }
