import { ImageResponse } from "next/og";

// 180x180 raster icon for iOS home-screen installs. Generated with Satori so
// it stays in sync with the brand chrome — no manual export step. Edge runtime
// matches opengraph-image.tsx for cold-start consistency.
export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#3D2A14",
          color: "#FAF8F6",
          fontSize: 110,
          fontWeight: 700,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          borderRadius: 40,
        }}
      >
        ✓
      </div>
    ),
    { ...size },
  );
}
