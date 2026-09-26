import { readFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

let _spec: Record<string, unknown> | null = null;

function loadSpec(): Record<string, unknown> {
  if (_spec) return _spec;

  const yamlPath = resolve(__dirname, "../../spec/openapi.yaml");
  const raw = readFileSync(yamlPath, "utf-8");

  _spec = yaml.load(raw) as Record<string, unknown>;
  return _spec;
}

function collectPaths(spec: Record<string, unknown>): string[] {
  const paths = spec["paths"] as Record<string, unknown> | undefined;
  if (!paths) return [];
  return Object.keys(paths);
}

function collectMethodsForPath(spec: Record<string, unknown>, path: string): string[] {
  const paths = spec["paths"] as Record<string, unknown>;
  const methods = paths[path] as Record<string, unknown>;
  return Object.keys(methods).filter((m) => ["get", "post", "put", "patch", "delete"].includes(m));
}

// Expected routes derived from server route registrations
const EXPECTED_ROUTES: Array<{ path: string; methods: string[] }> = [
  { path: "/health", methods: ["get"] },
  { path: "/robots.txt", methods: ["get"] },
  { path: "/api/seo/controls", methods: ["get", "post"] },
  { path: "/api/improve-proxy", methods: ["post"] },
  { path: "/api/prompts", methods: ["get", "post"] },
  { path: "/api/prompts/{id}", methods: ["get"] },
  { path: "/api/prompts/{id}/publish", methods: ["post"] },
  { path: "/api/prompts/{id}/archive", methods: ["post"] },
  { path: "/api/prompts/{id}/submit-review", methods: ["post"] },
  { path: "/api/prompts/{id}/review-checklist", methods: ["patch"] },
  { path: "/api/prompts/{id}/tags", methods: ["post", "delete"] },
  { path: "/api/prompts/{id}/versions", methods: ["post", "get"] },
  { path: "/api/prompts/{id}/versions/{versionIndex}", methods: ["get"] },
  { path: "/api/prompts/buyer/{walletAddress}/owned", methods: ["get"] },
  { path: "/api/prompts/buyer/{walletAddress}/transactions", methods: ["get"] },
  { path: "/api/prompts/buyer/{walletAddress}/saved", methods: ["get"] },
  { path: "/api/prompts/buyer/save", methods: ["post"] },
  { path: "/api/prompts/buyer/unsave", methods: ["post"] },
  { path: "/api/prompts/creator/{walletAddress}/transactions", methods: ["get"] },
  { path: "/api/prompts/creator/{walletAddress}/drafts", methods: ["get"] },
  { path: "/api/user", methods: ["post", "get"] },
  { path: "/api/user/preferences", methods: ["get", "put"] },
  { path: "/api/user/export/challenge", methods: ["post"] },
  { path: "/api/user/export", methods: ["post"] },
  { path: "/api/user/export/download/{exportId}", methods: ["get"] },
  { path: "/api/versions/update", methods: ["post"] },
  { path: "/api/versions/{promptId}/history", methods: ["get"] },
  { path: "/api/versions/purchase", methods: ["post"] },
  { path: "/api/versions/buyer-version", methods: ["get"] },
  { path: "/api/governance/vote/{promptId}", methods: ["post", "delete"] },
  { path: "/api/governance/votes/{promptId}", methods: ["get"] },
  { path: "/api/governance/top", methods: ["get"] },
  { path: "/api/appeals", methods: ["post"] },
  { path: "/api/appeals/{id}", methods: ["get"] },
  { path: "/api/appeals/decision/{decisionId}", methods: ["get"] },
  { path: "/api/appeals/{id}/resolve", methods: ["post"] },
  { path: "/api/appeals/{id}/withdraw", methods: ["post"] },
  { path: "/api/license-terms/active", methods: ["get"] },
  { path: "/api/license-terms/version/{version}", methods: ["get"] },
  { path: "/api/license-terms/listing/{promptId}", methods: ["get"] },
  { path: "/api/license-terms/create", methods: ["post"] },
  { path: "/api/webhooks", methods: ["post", "get", "delete"] },
  { path: "/api/webhooks/rotate-secret", methods: ["post"] },
  { path: "/api/webhooks/test", methods: ["post"] },
  { path: "/api/webhooks/deliveries", methods: ["get"] },
  { path: "/api/webhooks/health", methods: ["get"] },
  { path: "/api/webhooks/dead-letters", methods: ["get"] },
  { path: "/api/webhooks/dead-letters/{id}/replay", methods: ["post"] },
  { path: "/api/webhooks/replay/events", methods: ["get"] },
  { path: "/api/webhooks/replay/queue", methods: ["get"] },
  { path: "/api/webhooks/replay/preview", methods: ["post"] },
  { path: "/api/notifications", methods: ["get"] },
  { path: "/api/notifications/{id}/read", methods: ["patch"] },
  { path: "/api/prompt-order", methods: ["get", "put"] },
  { path: "/api-keys", methods: ["get", "post"] },
  { path: "/api-keys/{id}", methods: ["delete"] },
  { path: "/api-keys/{id}/rotate", methods: ["post"] },
  { path: "/api/analytics-rollups", methods: ["get"] },
  { path: "/api/analytics-rollups/trigger", methods: ["post"] },
  // Direct routes (not mounted under /api prefix but still in spec)
  { path: "/api/chat", methods: ["post"] },
  { path: "/api/test-prompt", methods: ["post"] },
  // Report routes (in controllers but mounted in prompt router)
  { path: "/api/prompts/report", methods: ["post"] },
  { path: "/api/prompts/reports", methods: ["get"] },
  { path: "/api/prompts/preview", methods: ["post"] },
  { path: "/api/prompts/preview-stats", methods: ["get"] },
];

describe("OpenAPI Specification — server/spec/openapi.yaml", () => {
  let spec: Record<string, unknown>;

  beforeAll(() => {
    spec = loadSpec();
  });

  describe("Spec structure", () => {
    it("loads and parses the spec without errors", () => {
      expect(spec).toBeDefined();
      expect(spec.openapi).toBe("3.1.0");
    });

    it("has required top-level fields", () => {
      expect(spec.info).toBeDefined();
      expect((spec.info as Record<string, unknown>).title).toBe("Prompt Mint API");
      expect((spec.info as Record<string, unknown>).version).toBe("1.0.0");
      expect(spec.paths).toBeDefined();
      expect(spec.components).toBeDefined();
    });

    it("has servers defined", () => {
      expect(spec.servers).toBeDefined();
      expect(Array.isArray(spec.servers)).toBe(true);
      expect((spec.servers as unknown[]).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Path coverage", () => {
    it.each(EXPECTED_ROUTES)("covers $method $path", ({ path, methods }) => {
      const specPaths = collectPaths(spec);
      expect(specPaths).toContain(path);

      const specMethods = collectMethodsForPath(spec, path);
      for (const method of methods) {
        expect(specMethods).toContain(method);
      }
    });

    it("does not have undocumented paths in spec", () => {
      const specPaths = collectPaths(spec);
      const expectedPaths = EXPECTED_ROUTES.map((r) => r.path);

      for (const sp of specPaths) {
        // Skip extension paths
        if (sp.startsWith("x-")) continue;
        expect(expectedPaths).toContain(sp);
      }
    });

    it("has no overlapping path parameter conflicts", () => {
      const specPaths = collectPaths(spec);
      for (const p of specPaths) {
        const paramCount = (p.match(/\{/g) || []).length;
        expect(paramCount).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("Operation completeness", () => {
    it.each(collectPaths(loadSpec()))("path %s has required operation fields", (path: string) => {
      const pathItem = ((spec as Record<string, unknown>).paths as Record<string, unknown>)[path] as Record<string, unknown>;
      const operations = ["get", "post", "put", "patch", "delete"].filter((m) => pathItem[m]);

      for (const opName of operations) {
        const op = pathItem[opName] as Record<string, unknown>;
        expect(op.operationId).toBeDefined();
        expect(typeof op.operationId).toBe("string");
        expect(op.summary).toBeDefined();
        expect(typeof op.summary).toBe("string");
        expect(op.responses).toBeDefined();
      }
    });
  });

  describe("Response schemas", () => {
    it("every operation has a 200 or 201 response", () => {
      const paths = (spec as Record<string, unknown>).paths as Record<string, unknown>;
      for (const [, pathItem] of Object.entries(paths)) {
        const item = pathItem as Record<string, unknown>;
        const operations = ["get", "post", "put", "patch", "delete"].filter((m) => item[m]);
        for (const opName of operations) {
          const op = item[opName] as Record<string, unknown>;
          const responses = op.responses as Record<string, unknown>;
          const hasSuccess = responses["200"] || responses["201"];
          expect(hasSuccess).toBeDefined();
        }
      }
    });

    it("error responses reference standard components or are defined inline", () => {
      const paths = (spec as Record<string, unknown>).paths as Record<string, unknown>;
      for (const [, pathItem] of Object.entries(paths)) {
        const item = pathItem as Record<string, unknown>;
        const operations = ["get", "post", "put", "patch", "delete"].filter((m) => item[m]);
        for (const opName of operations) {
          const op = item[opName] as Record<string, unknown>;
          const responses = op.responses as Record<string, unknown>;
          for (const [code, response] of Object.entries(responses)) {
            if (code.startsWith("4") || code.startsWith("5")) {
              const resp = response as Record<string, unknown>;
              if (resp.$ref) {
                expect(resp.$ref).toMatch(/^#\/components\/responses\//);
              } else {
                expect(resp.description).toBeDefined();
              }
            }
          }
        }
      }
    });
  });

  describe("Security schemes", () => {
    it("has security schemes defined", () => {
      const components = (spec as Record<string, unknown>).components as Record<string, unknown>;
      expect(components.securitySchemes).toBeDefined();
    });

    it("marks admin-protected routes with security requirement", () => {
      // GET /api/prompts/reports requires adminToken
      const paths = (spec as Record<string, unknown>).paths as Record<string, unknown>;
      const reportsPath = paths["/api/prompts/reports"] as Record<string, unknown>;
      const getOp = reportsPath["get"] as Record<string, unknown>;
      expect(getOp.security).toBeDefined();
    });
  });

  describe("Schema definitions", () => {
    it("has Prompt schema with all required fields", () => {
      const components = (spec as Record<string, unknown>).components as Record<string, unknown>;
      const schemas = components.schemas as Record<string, unknown>;
      const promptSchema = schemas.Prompt as Record<string, unknown>;
      expect(promptSchema).toBeDefined();

      const props = promptSchema.properties as Record<string, unknown>;
      expect(props._id).toBeDefined();
      expect(props.title).toBeDefined();
      expect(props.content).toBeDefined();
      expect(props.price).toBeDefined();
      expect(props.owner).toBeDefined();
      expect(props.category).toBeDefined();
      expect(props.listingStatus).toBeDefined();
    });

    it("has User schema with required fields", () => {
      const schemas = ((spec as Record<string, unknown>).components as Record<string, unknown>).schemas as Record<string, unknown>;
      const userSchema = schemas.User as Record<string, unknown>;
      expect(userSchema).toBeDefined();

      const props = userSchema.properties as Record<string, unknown>;
      expect(props.walletAddress).toBeDefined();
      expect(props.username).toBeDefined();
    });

    it("has all component response references resolvable", () => {
      const components = (spec as Record<string, unknown>).components as Record<string, unknown>;
      const responses = components.responses as Record<string, unknown>;
      const expectedResponses = ["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Unprocessable", "ServiceUnavailable", "GatewayTimeout"];

      for (const name of expectedResponses) {
        expect(responses[name]).toBeDefined();
      }
    });
  });

  describe("Edge cases and backward compatibility", () => {
    it("does not remove or rename existing documented paths", () => {
      // This is a compatibility baseline: paths that existed when the spec was
      // first published must remain stable unless a migration is documented.
      const specPaths = collectPaths(spec);

      // These critical paths must always be present
      const criticalPaths = [
        "/api/prompts",
        "/api/prompts/{id}",
        "/api/user",
        "/api/governance/vote/{promptId}",
        "/api/governance/top",
        "/api/appeals",
        "/api/license-terms/active",
        "/api/webhooks",
        "/api-keys",
      ];

      for (const cp of criticalPaths) {
        expect(specPaths).toContain(cp);
      }
    });

    it("all parameterized paths use consistent naming", () => {
      const specPaths = collectPaths(spec);
      const paramPattern = /\{(\w+)\}/g;

      for (const p of specPaths) {
        let match: RegExpExecArray | null;
        while ((match = paramPattern.exec(p)) !== null) {
          // Parameter names should be camelCase
          expect(match[1]).toMatch(/^[a-z][a-zA-Z0-9]*$/);
        }
      }
    });

    it("all operationIds are unique", () => {
      const paths = (spec as Record<string, unknown>).paths as Record<string, unknown>;
      const ids = new Set<string>();

      for (const [, pathItem] of Object.entries(paths)) {
        const item = pathItem as Record<string, unknown>;
        const operations = ["get", "post", "put", "patch", "delete"].filter((m) => item[m]);
        for (const opName of operations) {
          const op = item[opName] as Record<string, unknown>;
          const id = op.operationId as string;
          expect(ids.has(id)).toBe(false);
          ids.add(id);
        }
      }
    });
  });
});
