"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  Package,
  BookUser,
  ArrowLeftRight,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { navItems } from "@/lib/navigation";

const iconMap: Record<string, LucideIcon> = {
  LayoutDashboard,
  Inbox,
  Package,
  BookUser,
  ArrowLeftRight,
  Settings,
};

// Fixed 56px dark icon rail. Icon buttons fill with brand blue on hover/active;
// a dark tooltip label appears to the right after a 200ms delay.
export default function Sidebar() {
  const pathname = usePathname();
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [showTooltip, setShowTooltip] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = (key: string) => {
    setHoveredItem(key);
    timerRef.current = setTimeout(() => setShowTooltip(key), 200);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHoveredItem(null);
    setShowTooltip(null);
  };

  return (
    <aside
      style={{ backgroundColor: "var(--rail)", width: 56 }}
      className="fixed top-0 left-0 h-screen flex flex-col z-40"
    >
      {/* Logo — not a link; purely decorative */}
      <div
        className="flex items-center justify-center"
        style={{ paddingTop: 12, paddingBottom: 16 }}
      >
        <div
          className="rounded-full bg-white flex items-center justify-center"
          style={{ width: 32, height: 32 }}
        >
          <span style={{ color: "var(--rail)", fontSize: 14 }} className="font-bold">
            d
          </span>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 flex flex-col items-center" style={{ paddingTop: 4 }}>
        {navItems.map((item) => {
          const Icon = iconMap[item.icon];
          const isActive =
            pathname === item.path || pathname?.startsWith(item.path + "/");
          const isHovered = hoveredItem === item.key;

          return (
            <div
              key={item.key}
              className="relative flex items-center justify-center"
              style={{ width: 56, height: 56 }}
              onMouseEnter={() => handleMouseEnter(item.key)}
              onMouseLeave={handleMouseLeave}
            >
              <Link
                href={item.path}
                aria-label={item.label}
                className="flex items-center justify-center"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  backgroundColor:
                    isActive || isHovered ? "var(--primary)" : "transparent",
                  transition: "background-color 150ms ease",
                }}
              >
                {Icon && (
                  <Icon size={22} style={{ color: "#FFFFFF" }} className="flex-shrink-0" />
                )}
              </Link>

              <div
                className="absolute top-1/2 pointer-events-none"
                style={{
                  left: "calc(100% + 8px)",
                  transform: "translateY(-50%)",
                  backgroundColor: "#0F172A",
                  color: "#FFFFFF",
                  fontSize: 13,
                  fontWeight: 500,
                  padding: "6px 12px",
                  borderRadius: 6,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                  whiteSpace: "nowrap",
                  opacity: showTooltip === item.key ? 1 : 0,
                  transition: "opacity 150ms ease",
                  visibility: showTooltip === item.key ? "visible" : "hidden",
                  zIndex: 50,
                }}
              >
                {item.label}
              </div>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
