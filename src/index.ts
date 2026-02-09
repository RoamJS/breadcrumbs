import runExtension from "roamjs-components/util/runExtension";

type LocationType = "page" | "block";

type Location = {
  type: LocationType;
  uid: string;
};

type BreadcrumbItem = {
  uid: string;
  type: LocationType;
  title: string;
};

type ExtensionSettings = {
  maxBreadcrumbs: number;
  truncateLength: number;
};

type ExtensionAPI = {
  settings: {
    get: (key: string) => unknown;
    panel: {
      create: (args: {
        tabTitle: string;
        settings: {
          id: string;
          name: string;
          description: string;
          action: {
            type: string;
            placeholder?: string;
          };
        }[];
      }) => void;
    };
  };
};

const SETTINGS_DEFAULTS: ExtensionSettings = {
  maxBreadcrumbs: 8,
  truncateLength: 25,
};

const PANEL_ID = "roam-breadcrumbs-panel";
const STYLE_ID = "roam-breadcrumbs-styles";

let history: BreadcrumbItem[] = [];
let currentLocation: Location | null = null;
let hashChangeListener: (() => void) | null = null;

const toPositiveNumber = ({
  value,
  fallback,
}: {
  value: unknown;
  fallback: number;
}): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const getSettings = ({
  extensionAPI,
}: {
  extensionAPI: ExtensionAPI;
}): ExtensionSettings => ({
  maxBreadcrumbs: toPositiveNumber({
    value: extensionAPI.settings.get("maxBreadcrumbs"),
    fallback: SETTINGS_DEFAULTS.maxBreadcrumbs,
  }),
  truncateLength: toPositiveNumber({
    value: extensionAPI.settings.get("truncateLength"),
    fallback: SETTINGS_DEFAULTS.truncateLength,
  }),
});

const getLocationFromHash = (): Location | null => {
  const hash = window.location.hash;

  const blockMatch = hash.match(/\/page\/[^?]+\?.*block=([a-zA-Z0-9_-]+)/);
  if (blockMatch?.[1]) {
    return { type: "block", uid: blockMatch[1] };
  }

  const pageMatch = hash.match(/\/page\/([a-zA-Z0-9_-]+)/);
  if (pageMatch?.[1]) {
    return { type: "page", uid: pageMatch[1] };
  }

  return null;
};

const getBlockOrPageInfo = async ({ uid }: { uid: string }): Promise<BreadcrumbItem | null> => {
  const pageResult = await window.roamAlphaAPI.q<[[string]]>(`
    [:find ?title
     :where [?e :block/uid "${uid}"]
            [?e :node/title ?title]]
  `);

  if (pageResult?.[0]?.[0]) {
    return {
      uid,
      type: "page",
      title: pageResult[0][0],
    };
  }

  const blockResult = await window.roamAlphaAPI.q<[[string]]>(`
    [:find ?string
     :where [?e :block/uid "${uid}"]
            [?e :block/string ?string]]
  `);

  if (blockResult?.length) {
    return {
      uid,
      type: "block",
      title: blockResult[0][0] || "(empty block)",
    };
  }

  return null;
};

const stripMarkdown = ({ text }: { text: string }): string =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\(\(([^)]+)\)\)/g, "->")
    .replace(/```[^`]*```/g, "[code]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, "[img]")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/{{.*?}}/g, "")
    .replace(/#\[\[([^\]]+)\]\]/g, "#$1")
    .trim();

const truncateText = ({ text, maxLength }: { text: string; maxLength: number }): string => {
  const cleaned = stripMarkdown({ text });
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.substring(0, maxLength - 1)}...`;
};

const navigateTo = ({ uid, type }: { uid: string; type: LocationType }): void => {
  if (type === "page") {
    window.roamAlphaAPI.ui.mainWindow.openPage({ page: { uid } });
    return;
  }

  window.roamAlphaAPI.ui.mainWindow.openBlock({ block: { uid } });
};

const createSeparator = (): HTMLSpanElement => {
  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = ">";
  return separator;
};

const createBreadcrumbElement = ({
  item,
  isCurrent,
  truncateLength,
}: {
  item: BreadcrumbItem;
  isCurrent: boolean;
  truncateLength: number;
}): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = `breadcrumb-item ${
    item.type === "page" ? "breadcrumb-page" : "breadcrumb-block"
  } ${isCurrent ? "breadcrumb-current" : ""}`;
  element.textContent = truncateText({ text: item.title, maxLength: truncateLength });
  element.title = stripMarkdown({ text: item.title });

  if (!isCurrent) {
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigateTo({ uid: item.uid, type: item.type });
    });
  }

  return element;
};

const renderBreadcrumbs = ({ truncateLength }: { truncateLength: number }): void => {
  const container = document.getElementById(PANEL_ID);
  if (!container) return;

  const content = container.querySelector(".breadcrumbs-content");
  if (!(content instanceof HTMLElement)) return;

  content.innerHTML = "";

  if (!history.length) {
    content.textContent = "No history yet";
    return;
  }

  const displayOrder = [...history].reverse();

  displayOrder.forEach((item, index) => {
    const isCurrent = index === displayOrder.length - 1;

    if (index > 0) {
      content.appendChild(createSeparator());
    }

    content.appendChild(
      createBreadcrumbElement({ item, isCurrent, truncateLength })
    );
  });
};

const handleNavigation = async ({
  maxBreadcrumbs,
  truncateLength,
}: ExtensionSettings): Promise<void> => {
  const location = getLocationFromHash();
  if (!location) return;

  if (currentLocation?.uid === location.uid) return;

  const info = await getBlockOrPageInfo({ uid: location.uid });
  if (!info) return;

  history = history.filter((item) => item.uid !== info.uid);
  history.unshift(info);

  if (history.length > maxBreadcrumbs + 1) {
    history = history.slice(0, maxBreadcrumbs + 1);
  }

  currentLocation = location;
  renderBreadcrumbs({ truncateLength });
};

const createBreadcrumbsPanel = (): void => {
  document.getElementById(PANEL_ID)?.remove();

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `<div class="breadcrumbs-content"></div>`;

  const topbar = document.querySelector(".rm-topbar");
  if (!(topbar instanceof HTMLElement)) return;

  const firstChild = topbar.firstChild;
  if (firstChild?.nextSibling) {
    topbar.insertBefore(panel, firstChild.nextSibling);
    return;
  }

  topbar.appendChild(panel);
};

const injectStyles = (): void => {
  if (document.getElementById(STYLE_ID)) return;

  const styles = document.createElement("style");
  styles.id = STYLE_ID;
  styles.textContent = `
    #${PANEL_ID} {
      display: flex;
      align-items: center;
      padding: 0 12px;
      flex-grow: 1;
      min-width: 0;
      overflow: hidden;
    }

    .breadcrumbs-content {
      display: flex;
      align-items: center;
      gap: 4px;
      overflow: hidden;
      white-space: nowrap;
      font-size: 13px;
    }

    .breadcrumb-item {
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: background-color 0.15s ease;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
    }

    .breadcrumb-item:hover:not(.breadcrumb-current) {
      background-color: rgba(0, 0, 0, 0.08);
    }

    .breadcrumb-page {
      color: #137cbd;
      font-weight: 500;
    }

    .breadcrumb-block {
      color: #5c7080;
      font-style: italic;
    }

    .breadcrumb-block::before {
      content: "*";
      margin-right: 4px;
      opacity: 0.5;
    }

    .breadcrumb-current {
      background-color: rgba(19, 124, 189, 0.1);
      cursor: default;
    }

    .breadcrumb-separator {
      color: #8a9ba8;
      margin: 0 2px;
      user-select: none;
    }

    .bp3-dark #${PANEL_ID} .breadcrumb-item:hover:not(.breadcrumb-current) {
      background-color: rgba(255, 255, 255, 0.1);
    }

    .bp3-dark #${PANEL_ID} .breadcrumb-page {
      color: #48aff0;
    }

    .bp3-dark #${PANEL_ID} .breadcrumb-block {
      color: #a7b6c2;
    }

    .bp3-dark #${PANEL_ID} .breadcrumb-current {
      background-color: rgba(72, 175, 240, 0.15);
    }

    .bp3-dark #${PANEL_ID} .breadcrumb-separator {
      color: #5c7080;
    }
  `;

  document.head.appendChild(styles);
};

const cleanup = (): void => {
  if (hashChangeListener) {
    window.removeEventListener("hashchange", hashChangeListener);
    hashChangeListener = null;
  }

  document.getElementById(PANEL_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();

  history = [];
  currentLocation = null;
};

export default runExtension(async ({ extensionAPI }) => {
  extensionAPI.settings.panel.create({
    tabTitle: "Breadcrumbs",
    settings: [
      {
        id: "enabled",
        name: "Enable breadcrumbs",
        description: "Show navigation breadcrumbs in the Roam top bar",
        action: { type: "switch" },
      },
      {
        id: "maxBreadcrumbs",
        name: "Max breadcrumbs",
        description: "Maximum number of previous locations to keep",
        action: { type: "input", placeholder: `${SETTINGS_DEFAULTS.maxBreadcrumbs}` },
      },
      {
        id: "truncateLength",
        name: "Truncate length",
        description: "Maximum breadcrumb label length before truncation",
        action: { type: "input", placeholder: `${SETTINGS_DEFAULTS.truncateLength}` },
      },
    ],
  });

  if ((extensionAPI.settings.get("enabled") as boolean | undefined) === false) {
    return;
  }

  const settings = getSettings({ extensionAPI: extensionAPI as ExtensionAPI });

  injectStyles();
  createBreadcrumbsPanel();

  hashChangeListener = () => {
    void handleNavigation(settings);
  };
  window.addEventListener("hashchange", hashChangeListener);

  await handleNavigation(settings);

  return {
    unload: cleanup,
  };
});
