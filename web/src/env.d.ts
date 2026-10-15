// Vite's `?url` import: the URL of the emitted asset (the pdf.js worker).
declare module '*?url' {
  const url: string;
  export default url;
}
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
