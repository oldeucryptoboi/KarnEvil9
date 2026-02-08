/**
 * Resolve a Target to a DOM element via Runtime.evaluate.
 * Same priority chain as ManagedDriver: role > label > placeholder > text > selector, with nth.
 * Returns a Runtime.RemoteObjectId for subsequent CDP calls.
 */

import type { CDPClient } from "./client.js";
import type { Target } from "../types.js";

/** Implicit ARIA role → CSS selector map for common roles. */
const ROLE_SELECTOR_MAP: Record<string, string> = {
  button: 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]',
  link: "a[href], [role=link]",
  heading: "h1, h2, h3, h4, h5, h6, [role=heading]",
  textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], textarea, [role="textbox"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  combobox: "select, [role=combobox]",
  listbox: "select[multiple], [role=listbox]",
  option: "option, [role=option]",
  listitem: "li, [role=listitem]",
  img: "img, [role=img]",
  navigation: "nav, [role=navigation]",
  main: "main, [role=main]",
  banner: "header, [role=banner]",
  contentinfo: "footer, [role=contentinfo]",
  complementary: "aside, [role=complementary]",
  search: '[role="search"]',
  form: "form, [role=form]",
  table: "table, [role=table]",
  row: "tr, [role=row]",
  cell: "td, [role=cell]",
  columnheader: "th, [role=columnheader]",
};

/** Build a JS expression that finds elements matching the target. Returns an array of elements. */
function buildFindExpression(target: Target): string {
  if (target.role) {
    const selector = ROLE_SELECTOR_MAP[target.role];
    if (selector) {
      if (target.name) {
        // Filter by accessible name (textContent, aria-label, or alt)
        return `(() => {
          const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
          const name = ${JSON.stringify(target.name)};
          return els.filter(el => {
            const ariaLabel = el.getAttribute("aria-label") || "";
            const alt = el.getAttribute("alt") || "";
            const text = (el.textContent || "").trim();
            const title = el.getAttribute("title") || "";
            const value = el.value || "";
            return ariaLabel === name || alt === name || text === name || title === name || value === name;
          });
        })()`;
      }
      return `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
    }
    // Unknown role — try [role="<role>"]
    const roleSelector = `[role="${target.role}"]`;
    if (target.name) {
      return `(() => {
        const els = Array.from(document.querySelectorAll(${JSON.stringify(roleSelector)}));
        const name = ${JSON.stringify(target.name)};
        return els.filter(el => {
          const ariaLabel = el.getAttribute("aria-label") || "";
          const text = (el.textContent || "").trim();
          return ariaLabel === name || text === name;
        });
      })()`;
    }
    return `Array.from(document.querySelectorAll(${JSON.stringify(roleSelector)}))`;
  }

  if (target.label) {
    return `(() => {
      const label = ${JSON.stringify(target.label)};
      const labels = Array.from(document.querySelectorAll("label"));
      const match = labels.find(l => (l.textContent || "").trim() === label);
      if (match && match.htmlFor) {
        const el = document.getElementById(match.htmlFor);
        return el ? [el] : [];
      }
      if (match) {
        const input = match.querySelector("input, textarea, select");
        return input ? [input] : [];
      }
      // Fallback: aria-label
      const byAria = Array.from(document.querySelectorAll('[aria-label="' + label.replace(/"/g, '\\\\"') + '"]'));
      return byAria;
    })()`;
  }

  if (target.placeholder) {
    return `Array.from(document.querySelectorAll('[placeholder="${target.placeholder.replace(/"/g, '\\"')}"]'))`;
  }

  if (target.text) {
    return `(() => {
      const text = ${JSON.stringify(target.text)};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      const results = [];
      let node;
      while (node = walker.nextNode()) {
        if ((node.textContent || "").trim() === text && node.children.length === 0) {
          results.push(node);
        }
      }
      return results;
    })()`;
  }

  if (target.selector) {
    return `Array.from(document.querySelectorAll(${JSON.stringify(target.selector)}))`;
  }

  throw new Error("Target must specify at least one of: role, label, placeholder, text, selector");
}

export interface ResolvedElement {
  objectId: string;
}

/**
 * Resolve a Target to a remote DOM element.
 * Returns the Runtime.RemoteObjectId of the matching element.
 */
export async function resolveTarget(
  cdp: CDPClient,
  target: Target,
): Promise<ResolvedElement> {
  const findExpr = buildFindExpression(target);
  const nth = target.nth ?? 0;

  // Evaluate to find matching elements, return the nth one
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const matches = ${findExpr};
      const idx = ${nth};
      if (!matches || matches.length === 0) return { __notFound: true, count: 0 };
      if (idx >= matches.length) return { __notFound: true, count: matches.length };
      if (matches.length > 1 && idx === 0 && ${nth === undefined || target.nth === undefined}) {
        // Multiple matches without nth — ambiguous
        return { __ambiguous: true, count: matches.length };
      }
      return matches[idx];
    })()`,
    returnByValue: false,
  });

  if (result.exceptionDetails) {
    throw new Error(`Target resolution failed: ${result.exceptionDetails.text}`);
  }

  // Check for not-found or ambiguous markers
  if (result.result.type === "object" && result.result.objectId) {
    // Got an element — but need to check if it's our error marker
    const check = await cdp.send("Runtime.callFunctionOn", {
      functionDeclaration: "function() { return this.__notFound || this.__ambiguous ? JSON.stringify(this) : null; }",
      objectId: result.result.objectId,
      returnByValue: true,
    });

    if (check.result.value) {
      const marker = JSON.parse(check.result.value as string);
      if (marker.__notFound) {
        throw new Error(`Element not found for target: ${JSON.stringify(target)}`);
      }
      if (marker.__ambiguous) {
        throw new Error(
          `Target resolved to ${marker.count} elements. Use nth to disambiguate: ${JSON.stringify(target)}`,
        );
      }
    }

    return { objectId: result.result.objectId };
  }

  throw new Error(`Element not found for target: ${JSON.stringify(target)}`);
}

/**
 * Call a function on a resolved element and return the result.
 */
export async function callOnElement<T>(
  cdp: CDPClient,
  element: ResolvedElement,
  fn: string,
  returnByValue = true,
): Promise<T> {
  const result = await cdp.send("Runtime.callFunctionOn", {
    functionDeclaration: fn,
    objectId: element.objectId,
    returnByValue,
  });

  if (result.exceptionDetails) {
    throw new Error(`callOnElement failed: ${result.exceptionDetails.text}`);
  }

  return result.result.value as T;
}

/**
 * Get the bounding rectangle of a resolved element.
 */
export async function getBoundingRect(
  cdp: CDPClient,
  element: ResolvedElement,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return callOnElement(cdp, element, `function() {
    const rect = this.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }`);
}

// Export for testing
export { buildFindExpression, ROLE_SELECTOR_MAP };
