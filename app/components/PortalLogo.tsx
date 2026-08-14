export function PortalLogo({ logoUrl, logoWidthPx }: { logoUrl: string | null; logoWidthPx: number | null }) {
  if (!logoUrl) return null;
  return (
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
      <img src={logoUrl} alt="" style={{ width: logoWidthPx ?? 140, height: "auto" }} />
    </div>
  );
}
