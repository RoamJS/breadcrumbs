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

type SettingsPanelField = {
  id: string;
  name: string;
  description: string;
  action: {
    type: string;
    placeholder?: string;
  };
};

type ExtensionAPI = {
  settings: {
    get: (key: string) => unknown;
    panel: {
      create: (args: { tabTitle: string; settings: SettingsPanelField[] }) => void;
    };
  };
};

const DEFAULT_SETTINGS: ExtensionSettings = {
  maxBreadcrumbs: 8,
  truncateLength: 25,
};

const UI_IDS = {
  panel: "roam-breadcrumbs-panel",
  styles: "roam-breadcrumbs-styles",
} as const;

const UI_SELECTORS = {
  topbar: ".rm-topbar",
  content: ".breadcrumbs-content",
} as const;

let breadcrumbHistory: BreadcrumbItem[] = [];
let currentLocation: Location | null = null;
let hashChangeListener: (() => void) | null = null;

const parsePositiveInteger = ({
  value,
  fallback,
}: {
  value: unknown;
  fallback: number;
}): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const readSettings = ({ extensionAPI }: { extensionAPI: ExtensionAPI }): ExtensionSettings => ({
  maxBreadcrumbs: parsePositiveInteger({
    value: extensionAPI.settings.get("maxBreadcrumbs"),
    fallback: DEFAULT_SETTINGS.maxBreadcrumbs,
  }),
  truncateLength: parsePositiveInteger({
    value: extensionAPI.settings.get("truncateLength"),
    fallback: DEFAULT_SETTINGS.truncateLength,
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

const queryPageTitle = async ({ uid }: { uid: string }): Promise<string | null> => {
  const pageResult = await window.roamAlphaAPI.q<[[string]]>(`
    [:find ?title
     :where [?e :block/uid "${uid}"]
            [?e :node/title ?title]]
  `);

  return pageResult?.[0]?.[0] || null;
};

const queryBlockString = async ({ uid }: { uid: string }): Promise<string | null> => {
  const blockResult = await window.roamAlphaAPI.q<[[string]]>(`
    [:find ?string
     :where [?e :block/uid "${uid}"]
            [?e :block/string ?string]]
  `);

  if (!blockResult?.length) return null;
  return blockResult[0][0] || "(empty block)";
};

const getBreadcrumbItemByUid = async ({ uid }: { uid: string }): Promise<BreadcrumbItem | null> => {
  const pageTitle = await queryPageTitle({ uid });
  if (pageTitle) {
    return {
      uid,
      type: "page",
      title: pageTitle,
    };
  }

  const blockString = await queryBlockString({ uid });
  if (!blockString) return null;

  return {
    uid,
    type: "block",
    title: blockString,
  };
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
  return `${cleaned.slice(0, maxLength - 1)}...`;
};

const navigateTo = ({ uid, type }: { uid: string; type: LocationType }): void => {
  if (type === "page") {
    window.roamAlphaAPI.ui.mainWindow.openPage({ page: { uid } });
    return;
  }

  window.roamAlphaAPI.ui.mainWindow.openBlock({ block: { uid } });
};

const createSeparatorElement = (): HTMLSpanElement => {
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
  const typeClass = item.type === "page" ? "breadcrumb-page" : "breadcrumb-block";

  element.className = `breadcrumb-item ${typeClass} ${isCurrent ? "breadcrumb-current" : ""}`.trim();
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

const getOrCreatePanel = (): HTMLElement | null => {
  const existingPanel = document.getElementById(UI_IDS.panel);
  if (existingPanel instanceof HTMLElement) return existingPanel;

  const topbar = document.querySelector(UI_SELECTORS.topbar);
  if (!(topbar instanceof HTMLElement)) return null;

  const panel = document.createElement("div");
  panel.id = UI_IDS.panel;

  const content = document.createElement("div");
  content.className = "breadcrumbs-content";
  panel.appendChild(content);

  const firstChild = topbar.firstChild;
  if (firstChild?.nextSibling) {
    topbar.insertBefore(panel, firstChild.nextSibling);
    return panel;
  }

  topbar.appendChild(panel);
  return panel;
};

const getContentContainer = (): HTMLElement | null => {
  const panel = getOrCreatePanel();
  if (!panel) return null;

  const content = panel.querySelector(UI_SELECTORS.content);
  return content instanceof HTMLElement ? content : null;
};

const renderBreadcrumbs = ({ truncateLength }: { truncateLength: number }): void => {
  const content = getContentContainer();
  if (!content) return;

  content.innerHTML = "";

  if (!breadcrumbHistory.length) {
    content.textContent = "No history yet";
    return;
  }

  const displayOrder = [...breadcrumbHistory].reverse();

  displayOrder.forEach((item, index) => {
    const isCurrent = index === displayOrder.length - 1;

    if (index > 0) {
      content.appendChild(createSeparatorElement());
    }

    content.appendChild(createBreadcrumbElement({ item, isCurrent, truncateLength }));
  });
};

const updateBreadcrumbHistory = ({
  item,
  maxBreadcrumbs,
}: {
  item: BreadcrumbItem;
  maxBreadcrumbs: number;
}): void => {
  breadcrumbHistory = breadcrumbHistory.filter((historyItem) => historyItem.uid !== item.uid);
  breadcrumbHistory.unshift(item);

  const maxEntries = maxBreadcrumbs + 1;
  if (breadcrumbHistory.length > maxEntries) {
    breadcrumbHistory = breadcrumbHistory.slice(0, maxEntries);
  }
};

const handleNavigation = async ({
  maxBreadcrumbs,
  truncateLength,
}: ExtensionSettings): Promise<void> => {
  const location = getLocationFromHash();
  if (!location) return;

  if (currentLocation?.uid === location.uid) return;

  const breadcrumbItem = await getBreadcrumbItemByUid({ uid: location.uid });
  if (!breadcrumbItem) return;

  updateBreadcrumbHistory({ item: breadcrumbItem, maxBreadcrumbs });
  currentLocation = location;

  renderBreadcrumbs({ truncateLength });
};

const injectStyles = (): void => {
  if (document.getElementById(UI_IDS.styles)) return;

  const styles = document.createElement("style");
  styles.id = UI_IDS.styles;
  styles.textContent = `
    #${UI_IDS.panel} {
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

    .bp3-dark #${UI_IDS.panel} .breadcrumb-item:hover:not(.breadcrumb-current) {
      background-color: rgba(255, 255, 255, 0.1);
    }

    .bp3-dark #${UI_IDS.panel} .breadcrumb-page {
      color: #48aff0;
    }

    .bp3-dark #${UI_IDS.panel} .breadcrumb-block {
      color: #a7b6c2;
    }

    .bp3-dark #${UI_IDS.panel} .breadcrumb-current {
      background-color: rgba(72, 175, 240, 0.15);
    }

    .bp3-dark #${UI_IDS.panel} .breadcrumb-separator {
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

  document.getElementById(UI_IDS.panel)?.remove();
  document.getElementById(UI_IDS.styles)?.remove();

  breadcrumbHistory = [];
  currentLocation = null;
};

export default runExtension(async ({ extensionAPI }) => {
  const typedExtensionAPI = extensionAPI as ExtensionAPI;

  typedExtensionAPI.settings.panel.create({
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
        action: { type: "input", placeholder: `${DEFAULT_SETTINGS.maxBreadcrumbs}` },
      },
      {
        id: "truncateLength",
        name: "Truncate length",
        description: "Maximum breadcrumb label length before truncation",
        action: { type: "input", placeholder: `${DEFAULT_SETTINGS.truncateLength}` },
      },
    ],
  });

  if ((typedExtensionAPI.settings.get("enabled") as boolean | undefined) === false) {
    return;
  }

  const settings = readSettings({ extensionAPI: typedExtensionAPI });

  injectStyles();
  getOrCreatePanel();

  hashChangeListener = () => {
    void handleNavigation(settings);
  };
  window.addEventListener("hashchange", hashChangeListener);

  await handleNavigation(settings);

  return {
    unload: cleanup,
  };
});
