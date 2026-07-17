/// <reference types="vite/client" />

// the embedded browser panel renders an Electron <webview>, which React's JSX
// doesn't know about
declare namespace React.JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<Electron.WebviewTag>,
      Electron.WebviewTag
    > & {
      src?: string
      partition?: string
    }
  }
}
