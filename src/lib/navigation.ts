// Sidebar navigation. `icon` must match a key in the iconMap in Sidebar.tsx.

export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: string;
}

export const navItems: NavItem[] = [
  { key: "matching", label: "Matching", path: "/matching", icon: "Inbox" },
  { key: "contacts", label: "Contacts", path: "/contacts", icon: "BookUser" },
  { key: "import-export", label: "Import / Export", path: "/import-export", icon: "ArrowLeftRight" },
  { key: "settings", label: "Settings", path: "/settings", icon: "Settings" },
];
