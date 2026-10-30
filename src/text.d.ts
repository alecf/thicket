// Markdown imported `with { type: "text" }`, which Bun resolves to its text.
// See `src/report/guide.ts`.
declare module "*.md" {
  const text: string;
  export default text;
}
