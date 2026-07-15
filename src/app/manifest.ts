import type { MetadataRoute } from "next";

/**
 * PWA manifest. On iPhones that lack the in-browser Fullscreen API,
 * "Add to Home Screen" + display: fullscreen is the only way to play
 * without Safari chrome; Android gets it too as a nicety.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hover Weave",
    short_name: "Hover Weave",
    description:
      "Race a hovercraft through an endless neon landscape. Weave impossible gaps, build Flow, and chase the daily course.",
    start_url: "/",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#07060f",
    theme_color: "#07060f",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
