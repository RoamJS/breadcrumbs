const getOrCreatePanel = (): HTMLElement | null => {
  const existingPanel = document.getElementById("roam-breadcrumbs-panel");
  if (existingPanel instanceof HTMLElement) return existingPanel;

  // Keep extension DOM out of the sibling list Roam reconciles on sidebar toggles.
  const spacer = document.querySelector(".rm-topbar .rm-topbar__left-spacer");
  if (!(spacer instanceof HTMLElement)) return null;

  const panel = document.createElement("div");
  panel.id = "roam-breadcrumbs-panel";

  const content = document.createElement("div");
  content.className = "breadcrumbs-content";
  panel.appendChild(content);
  spacer.appendChild(panel);
  return panel;
};

export default getOrCreatePanel;
