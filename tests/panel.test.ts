import { expect, test } from "@playwright/test";
import { JSDOM } from "jsdom";
import getOrCreatePanel from "~/getOrCreatePanel";

test.beforeEach(() => {
  const { window } = new JSDOM(`
    <div class="rm-topbar">
      <span class="rm-open-left-sidebar-btn"></span>
      <div class="rm-topbar__spacer-sm"></div>
      <div class="rm-topbar__left-spacer"></div>
      <input placeholder="Find or Create Page" />
    </div>
  `);
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
  });
});

test("keeps the topbar child list intact when mounting breadcrumbs", () => {
  const topbar = document.querySelector(".rm-topbar")!;
  const children = Array.from(topbar.children);
  const panel = getOrCreatePanel();

  expect(Array.from(topbar.children)).toEqual(children);
  expect(panel?.parentElement?.className).toBe("rm-topbar__left-spacer");
  expect(panel?.querySelector(".breadcrumbs-content")).not.toBeNull();
  expect(getOrCreatePanel()).toBe(panel);
  expect(document.querySelectorAll("#roam-breadcrumbs-panel")).toHaveLength(1);
});

test("leaves a recreated sidebar toggle ahead of breadcrumbs", () => {
  const topbar = document.querySelector(".rm-topbar")!;
  const panel = getOrCreatePanel();
  document.querySelector(".rm-open-left-sidebar-btn")!.remove();
  const toggle = document.createElement("span");
  toggle.className = "rm-open-left-sidebar-btn";
  topbar.insertBefore(toggle, topbar.firstChild);

  expect(topbar.firstElementChild).toBe(toggle);
  expect(panel?.parentElement?.className).toBe("rm-topbar__left-spacer");
});

test("waits for the native spacer instead of inserting among native controls", () => {
  document.querySelector(".rm-topbar__left-spacer")!.remove();
  expect(getOrCreatePanel()).toBeNull();
  expect(document.getElementById("roam-breadcrumbs-panel")).toBeNull();
});
