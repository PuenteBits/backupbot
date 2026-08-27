import type { Engine } from "./schema";
import { parseDsn } from "./dsn";

/**
 * How to get a working connection string out of a hosted provider.
 *
 * Every provider offers several connection strings and only some of them can
 * serve a dump, so the choice is the whole difficulty — and picking wrong
 * usually fails later, on a schedule, rather than at the moment you paste it.
 * `inspectDsn` catches the wrong choices; this explains the right one.
 */
export interface ProviderGuide {
  id: string;
  name: string;
  engine: Engine;
  /** Where to click, in order. */
  steps: string[];
  /** The traps that are invisible until a backup fails. */
  pitfalls: string[];
  /** A well-formed DSN with the identifying parts left recognisable. */
  example: string;
  /** Hostname suffixes that identify a DSN as belonging to this provider. */
  hostSuffixes: string[];
}

const SUPABASE: ProviderGuide = {
  id: "supabase",
  name: "Supabase",
  engine: "postgres",
  steps: [
    "Open your project and click Connect in the top bar (or Project Settings → Database).",
    'Choose the "Session pooler" tab — not Transaction pooler, not Direct connection.',
    "Copy the URI. The host ends in .pooler.supabase.com and the port is 5432.",
    "Replace [YOUR-PASSWORD] with the database password (Settings → Database → Reset database password if you never saved it).",
    "Percent-encode any @ : / ? # in the password: @ → %40, : → %3A, / → %2F.",
  ],
  pitfalls: [
    "Port 6543 is the transaction pooler. It cannot serve pg_dump at all — the run will fail.",
    "db.<ref>.supabase.co is the direct connection: IPv6-only unless you pay for the IPv4 add-on.",
    "The database password is not your Supabase account password.",
  ],
  example: "postgresql://postgres.abcdefghijklmnop:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres",
  hostSuffixes: [".pooler.supabase.com", ".supabase.co", ".supabase.com"],
};

const RAILWAY: ProviderGuide = {
  id: "railway",
  name: "Railway",
  engine: "postgres",
  steps: [
    "Open the project and click the Postgres (or MySQL) service — not the app service.",
    "Go to the Variables tab.",
    "Copy DATABASE_PUBLIC_URL. For MySQL the variable is MYSQL_PUBLIC_URL.",
    "Check the host ends in .proxy.rlwy.net with a high random port — that is the public proxy.",
    "Percent-encode any @ : / ? # in the password: @ → %40, : → %3A, / → %2F.",
  ],
  pitfalls: [
    "DATABASE_URL (no _PUBLIC_) points at *.railway.internal, which only resolves inside Railway's own network. Nothing on your NAS can reach it.",
    "The public proxy port is assigned per service and changes if you re-provision the database.",
    "Dumps pulled over the public proxy count toward Railway's billed egress.",
  ],
  example: "postgresql://postgres:PASSWORD@ballast.proxy.rlwy.net:41234/railway",
  hostSuffixes: [".proxy.rlwy.net", ".railway.internal", ".railway.app"],
};

export const PROVIDER_GUIDES: readonly ProviderGuide[] = [SUPABASE, RAILWAY];

/** The guide matching a hostname, if one of them claims it. */
export function guideForHost(host: string): ProviderGuide | undefined {
  const lower = host.trim().toLowerCase();
  return PROVIDER_GUIDES.find((guide) => guide.hostSuffixes.some((suffix) => lower.endsWith(suffix)));
}

/**
 * The guide for a half-typed connection string. Never throws: this runs on
 * every keystroke in the add form, where most inputs are not yet valid URLs.
 */
export function guideForDsn(dsn: string): ProviderGuide | undefined {
  const trimmed = dsn.trim();
  if (!trimmed) return undefined;
  try {
    return guideForHost(parseDsn(trimmed).host);
  } catch {
    // Fall back to a substring match so the guide appears while still typing.
    const lower = trimmed.toLowerCase();
    return PROVIDER_GUIDES.find((guide) => guide.hostSuffixes.some((suffix) => lower.includes(suffix)));
  }
}
