import { IRInteraction, IRStyle } from "./types";
import { solidFill } from "./style";

/**
 * Figma has no CSS animations. What it DOES have is prototype reactions
 * (hover/press/click + transitions) and component variants. This derives real
 * CSS from those. Where a designer intended motion but recorded it nowhere,
 * nothing can recover it — we emit nothing rather than invent.
 */
export async function extractInteractions(node: SceneNode): Promise<IRInteraction[]> {
  const out: IRInteraction[] = [];
  const n = node as unknown as { reactions?: readonly Reaction[] };
  if (!n.reactions || !Array.isArray(n.reactions)) return out;

  for (const r of n.reactions) {
    const trig = r.trigger;
    if (!trig) continue;
    let trigger: IRInteraction["trigger"] | null = null;
    if (trig.type === "ON_HOVER") trigger = "hover";
    else if (trig.type === "ON_PRESS") trigger = "press";
    else if (trig.type === "ON_CLICK") trigger = "click";
    if (!trigger) continue;

    const actions = (r as unknown as { actions?: readonly Action[] }).actions
      || ((r as unknown as { action?: Action }).action ? [(r as unknown as { action: Action }).action] : []);

    for (const a of actions) {
      if (!a) continue;
      if (a.type === "NODE") {
        const na = a as unknown as {
          transition?: { duration?: number; easing?: { type?: string } };
        };
        const durationMs = na.transition?.duration
          ? Math.round(na.transition.duration * 1000) : 200;
        const easing = mapEasing(na.transition?.easing?.type);
        out.push({
          trigger, action: "style", durationMs, easing,
          cssHover: await hoverStyleFromVariant(node),
        });
      } else if (a.type === "URL") {
        out.push({ trigger, action: "navigate", target: (a as { url: string }).url });
      }
    }
  }
  return out;
}

function mapEasing(t?: string): string {
  switch (t) {
    case "EASE_IN": return "ease-in";
    case "EASE_OUT": return "ease-out";
    case "EASE_IN_AND_OUT": return "ease-in-out";
    case "LINEAR": return "linear";
    default: return "ease";
  }
}

/**
 * A component with a "Hover" variant states the hover style explicitly.
 * Read it rather than guessing a darken filter.
 */
async function hoverStyleFromVariant(
  node: SceneNode
): Promise<Partial<IRStyle> | undefined> {
  if (node.type !== "INSTANCE") return undefined;
  const inst = node as InstanceNode;
  // `documentAccess: "dynamic-page"` forbids the synchronous `mainComponent`
  // getter — it throws rather than returning null, which aborted the whole
  // export on any instance carrying a hover reaction.
  let main: ComponentNode | null = null;
  try {
    main = await inst.getMainComponentAsync();
  } catch (e) {
    return undefined;
  }
  const parent = main?.parent;
  if (!parent || parent.type !== "COMPONENT_SET") return undefined;

  const hover = parent.children.find((c) =>
    /hover/i.test(c.name)) as ComponentNode | undefined;
  if (!hover) return undefined;

  const s: Partial<IRStyle> = {};
  const bg = solidFill((hover as unknown as { fills: readonly Paint[] }).fills);
  if (bg) s.backgroundColor = bg;
  const op = (hover as unknown as { opacity?: number }).opacity;
  if (typeof op === "number" && op < 1) s.opacity = String(op);
  return Object.keys(s).length ? s : undefined;
}
