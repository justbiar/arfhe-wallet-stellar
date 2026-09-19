import { useSyncExternalStore } from "react";
import { english } from "./translations";

export type PanelLanguage = "en" | "tr";
const STORAGE_KEY = "arfhe_panel_language";
function readLanguage(): PanelLanguage {
  try { return localStorage.getItem(STORAGE_KEY) === "tr" ? "tr" : "en"; }
  catch { return "en"; }
}
let language = readLanguage();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => language;

export function setPanelLanguage(next: PanelLanguage) {
  language = next;
  document.documentElement.lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Session selection still works when storage is blocked. */ }
  listeners.forEach(listener => listener());
}
export function usePanelLanguage() {
  return { language: useSyncExternalStore(subscribe, snapshot, () => "en" as const), setLanguage: setPanelLanguage };
}
if (typeof document !== "undefined") document.documentElement.lang = language;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const templates = Object.entries(english).filter(([key]) => /\{\d+\}/.test(key))
  .sort(([a], [b]) => b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length).map(([key, value]) => ({
  expression: new RegExp("^" + key.split(/\{\d+\}/).map(escape).join("([\\s\\S]*?)") + "$"),
  value,
}));

/** Translate presentation values only; numbers, elements and transaction objects pass through. */
export function pt<T>(value: T): T {
  if (language === "tr" || typeof value !== "string") return value;
  const key = value.replace(/\s+/g, " ").trim();
  let translated = english[key];
  if (!translated) {
    for (const template of templates) {
      const match = template.expression.exec(key);
      if (match) {
        translated = template.value.replace(/\{(\d+)\}/g, (_, index) => english[match[Number(index) + 1]] ?? match[Number(index) + 1] ?? "");
        break;
      }
    }
  }
  if (!translated) return value;
  return ((/^\s/.test(value) ? " " : "") + translated + (/\s$/.test(value) ? " " : "")) as T;
}
