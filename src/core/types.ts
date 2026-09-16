// Normalized intermediate representation (IR).
// Both the HTML and JSX emitters consume this — one walk, two outputs.

export interface RGBA { r: number; g: number; b: number; a: number }

export interface IRStyle {
  // box
  width?: string; height?: string; minHeight?: string;
  maxWidth?: string; aspectRatio?: string;
  paddingTop?: string; paddingRight?: string;
  paddingBottom?: string; paddingLeft?: string;
  // flex (resolved from auto-layout — exact, never inferred)
  display?: string; flexDirection?: string; gap?: string;
  gridTemplateColumns?: string;
  alignItems?: string; justifyContent?: string; flexWrap?: string;
  flexGrow?: string; alignSelf?: string;
  // position (only when NOT auto-layout)
  position?: string; top?: string; left?: string;
  right?: string; bottom?: string; zIndex?: string;
  // paint
  backgroundColor?: string; backgroundImage?: string;
  backgroundSize?: string; backgroundPosition?: string; backgroundRepeat?: string;
  opacity?: string; mixBlendMode?: string;
  // border
  borderRadius?: string; border?: string;
  borderTop?: string; borderRight?: string;
  borderBottom?: string; borderLeft?: string;
  // effects
  boxShadow?: string; filter?: string; backdropFilter?: string;
  // text
  fontFamily?: string; fontSize?: string; fontWeight?: string;
  lineHeight?: string; letterSpacing?: string; color?: string;
  textAlign?: string; textTransform?: string;
  textDecoration?: string; fontStyle?: string;
  whiteSpace?: string; overflow?: string;
  objectFit?: string;
  // motion (derived from prototype reactions / variants)
  transition?: string;
  transform?: string;
}

export type IRTag =
  | "section" | "div" | "header" | "footer" | "nav" | "main" | "article"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "p" | "span" | "a" | "button" | "ul" | "li"
  | "img" | "video" | "svg";

export interface IRInteraction {
  trigger: "hover" | "press" | "click";
  action: "navigate" | "style" | "overlay";
  target?: string;
  cssHover?: Partial<IRStyle>;
  durationMs?: number;
  easing?: string;
}

export interface IRNode {
  id: string;             // figma node id
  name: string;           // figma layer name
  tag: IRTag;
  className: string;
  role?: string;          // semantic role: heading|body|cta|card|logo|icon...
  text?: string;
  href?: string;
  style: IRStyle;
  assetRef?: string;      // key into AssetMap
  assetKind?: "image" | "video" | "svg";
  svgMarkup?: string;     // inlined vector
  interactions?: IRInteraction[];
  children: IRNode[];
  // traceability
  figmaType: string;
  spacingSource: "auto-layout" | "absolute-coordinates";
  bbox: { x: number; y: number; width: number; height: number };
  /** Figma rotation in degrees (CCW positive) and the node's own unrotated size. */
  rotation?: number;
  size?: { width: number; height: number };
}

export interface IRSection {
  id: string;
  name: string;
  slug: string;
  root: IRNode;
  bbox: { x: number; y: number; width: number; height: number };
  /** From the AI plan, when one was used. */
  confidence?: number;
  note?: string;
}

export interface IRPage {
  name: string;
  slug: string;
  canvasWidth: number;
  canvasHeight: number;
  sections: IRSection[];
}

export interface AssetRecord {
  key: string;
  filename: string;
  kind: "image" | "video" | "svg";
  bytes: Uint8Array;
  hash: string;
  width?: number;
  height?: number;
  nodeName: string;
}

export type AssetMap = Map<string, AssetRecord>;
