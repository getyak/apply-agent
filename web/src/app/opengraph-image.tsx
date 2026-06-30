import { ImageResponse } from "next/og";

// File-convention OG image: Next discovers this automatically and wires it
// into <meta property="og:image">.
//
// We render the card as an inline SVG <img> via ImageResponse so we avoid
// Satori's strict layout rules (every multi-child <div> must be flex|none|
// contents) while still producing a content-typed PNG. The SVG keeps brand
// + copy under our own control, and Resvg (used by ImageResponse) rasterises
// it cleanly without needing dynamic font downloads.
export const runtime = "edge";

export const alt = "Vantage — Your job hunt, run by agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="paper" cx="20%" cy="25%" r="80%">
      <stop offset="0%" stop-color="#F2E2C9" />
      <stop offset="55%" stop-color="#FAF8F6" />
      <stop offset="100%" stop-color="#FAF8F6" />
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#paper)" />
  <rect width="1200" height="10" fill="#B5894A" />

  <!-- Wordmark spark -->
  <rect x="80" y="78" width="56" height="56" rx="14" fill="#3D2A14" />
  <path d="M95 108 l11 11 L122 96" stroke="#FAF8F6" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <text x="155" y="118" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="700" font-size="34" letter-spacing="6" fill="#3D2A14">VANTAGE</text>

  <!-- Headline -->
  <text x="80" y="320" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="700" font-size="84" letter-spacing="-1.5" fill="#3D2A14">Your job hunt,</text>
  <text x="80" y="408" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="700" font-size="84" letter-spacing="-1.5" fill="#B5894A">run by agents.</text>

  <!-- Tagline -->
  <text x="80" y="470" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="400" font-size="28" fill="#5A4A38">Résumés tailored, applications drafted, interviews prepped.</text>
  <text x="80" y="506" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-weight="400" font-size="28" fill="#5A4A38">You review and hit submit.</text>

  <!-- Trust pill -->
  <rect x="80" y="552" width="500" height="42" rx="21" fill="#FFFFFF" stroke="#E8DECF" />
  <circle cx="105" cy="573" r="6" fill="#2E8B57" />
  <text x="125" y="579" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" letter-spacing="1.2" fill="#3D2A14">CLIENT-SIDE · ZERO ACCOUNT RISK</text>

  <!-- Domain -->
  <text x="1120" y="579" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" fill="#8A7E6E">vantage.app</text>
</svg>
`.trim();

export default async function OG() {
  // ImageResponse takes a single image src and outputs the rasterised PNG.
  // The SVG is base64-encoded so it works as a data: URL on the edge.
  const dataUrl = `data:image/svg+xml;base64,${btoa(SVG)}`;
  return new ImageResponse(
    (
      <img
        src={dataUrl}
        width={size.width}
        height={size.height}
        alt={alt}
        style={{ display: "block" }}
      />
    ),
    { ...size },
  );
}
