// Broadcast channel between JsonViewer (the toolbar) and the recursive JsonTree
// nodes for "Expand all" / "Collapse all". Each node owns its own <details> open
// state, so there is no central tree to toggle — instead the viewer bumps `nonce`
// and sets `allOpen`, and every node reacts in an $effect. `nonce` starts at 0 as
// a sentinel meaning "no command issued yet", so the initial render keeps each
// node's default depth-based open state instead of being force-collapsed.
import { getContext, setContext } from "svelte";

export interface JsonTreeCtl {
  allOpen: boolean;
  nonce: number;
}

const JSON_TREE_CTL = Symbol("json-tree-ctl");

export function setJsonTreeCtl(ctl: JsonTreeCtl): void {
  setContext(JSON_TREE_CTL, ctl);
}

export function getJsonTreeCtl(): JsonTreeCtl | undefined {
  return getContext<JsonTreeCtl | undefined>(JSON_TREE_CTL);
}
