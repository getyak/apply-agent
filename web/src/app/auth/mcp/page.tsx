import McpAuthorizationView from "./view";

export default async function McpAuthorizationPage({
  searchParams,
}: {
  searchParams: Promise<{
    request_id?: string | string[];
  }>;
}) {
  const value = (await searchParams).request_id;
  const requestId = typeof value === "string" ? value : "";
  return <McpAuthorizationView requestId={requestId} />;
}
