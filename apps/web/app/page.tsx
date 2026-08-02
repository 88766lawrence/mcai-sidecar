import { OperationsConsole } from "../components/operations-console";

// The console shell changes with every web deployment.  Serving a statically
// prerendered entry document can leave clients pinned to an older chunk graph,
// even after the Next server has restarted.  Keep the HTML entry fresh while
// retaining immutable caching for the hashed static assets it references.
export const dynamic = "force-dynamic";

export default function Page() {
  return <OperationsConsole />;
}
