import type { MetadataRoute } from "next";

/**
 * PWA manifest. On iPhones that lack the in-browser Fullscreen API,
 * Home Screen launches use standalone mode on iOS. Browsers that support
 * fullscreen display can prefer it via display_override.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hover Weave",
    short_name: "Hover Weave",
    description:
      "Race a hovercraft through an endless neon landscape. Weave impossible gaps, build Flow, and chase the daily course.",
    start_url: "/",
    id: "/",
    scope: "/",
    display: "standalone",
    display_override: ["fullscreen", "standalone"],
    orientation: "landscape",
    background_color: "#07060f",
    theme_color: "#07060f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
