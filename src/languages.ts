/** Détermine le langage / type d'un fichier à partir de son nom. */

const BY_EXT: Record<string, string> = {
  c: 'C', h: 'C/C++ Header', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++ Header', hh: 'C++ Header',
  hxx: 'C++ Header', cs: 'C#', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', go: 'Go',
  rs: 'Rust', py: 'Python', pyw: 'Python', pyi: 'Python', rb: 'Ruby', php: 'PHP',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript JSX',
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript TSX',
  swift: 'Swift', m: 'Objective-C', mm: 'Objective-C++', dart: 'Dart', lua: 'Lua',
  pl: 'Perl', pm: 'Perl', r: 'R', sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell',
  ps1: 'PowerShell', psm1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro', json: 'JSON', jsonc: 'JSON', xml: 'XML',
  yml: 'YAML', yaml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'Config', conf: 'Config',
  md: 'Markdown', mdx: 'MDX', rst: 'reStructuredText', txt: 'Texte', sql: 'SQL',
  cmake: 'CMake', asm: 'Assembleur', s: 'Assembleur', hs: 'Haskell', ex: 'Elixir', exs: 'Elixir',
  erl: 'Erlang', clj: 'Clojure', fs: 'F#', vb: 'Visual Basic', zig: 'Zig', nim: 'Nim',
  jl: 'Julia', gradle: 'Gradle', proto: 'Protobuf', ipynb: 'Jupyter', csv: 'CSV', svg: 'SVG',
  tex: 'LaTeX', gd: 'GDScript', glsl: 'GLSL', hlsl: 'HLSL', sln: 'Visual Studio',
  csproj: 'Visual Studio', vcxproj: 'Visual Studio', plist: 'XML', lock: 'Lockfile',
  graphql: 'GraphQL', gql: 'GraphQL', tf: 'Terraform', sol: 'Solidity', elm: 'Elm', ml: 'OCaml',
};

const BY_NAME: Record<string, string> = {
  makefile: 'Makefile', gnumakefile: 'Makefile', dockerfile: 'Dockerfile',
  'cmakelists.txt': 'CMake', 'package-lock.json': 'Lockfile', 'yarn.lock': 'Lockfile',
  'pnpm-lock.yaml': 'Lockfile', 'cargo.lock': 'Lockfile', 'go.sum': 'Lockfile',
};

export function languageOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return dot === 0 ? base : '(sans extension)';
  const ext = lower.slice(dot + 1);
  return BY_EXT[ext] ?? '.' + ext;
}
