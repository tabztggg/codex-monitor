import {
  codexUsageFromRateLimitsRead,
  codexUsageFromRateLimitsUpdated,
  emptyCodexUsage
} from "../usage";

describe("Codex usage normalization", () => {
  it('uses map-only limits and preserves keyed bucket identities when values omit limitId', () => {
    const usage = codexUsageFromRateLimitsRead({ rateLimitsByLimitId: {
      codex_bengalfox: { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1777292438 } },
      codex: { secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 1777536841 } }
    } });
    expect(usage.status).toBe('available');
    expect(usage.error).toBeNull();
    expect(usage.limits.map(limit => limit.id)).toEqual(['codex_bengalfox', 'codex']);
    expect(usage.primaryLimit).toMatchObject({ id: 'codex', secondary: { usedPercent: 35 } });
  });

  it('uses the keyed overall quota instead of a stale legacy snapshot', () => {
    const usage = codexUsageFromRateLimitsRead({
      rateLimits: { limitId: 'codex', secondary: { usedPercent: 10, windowDurationMins: 10080 } },
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', secondary: { usedPercent: 35, windowDurationMins: 10080 } }
      }
    });
    expect(usage.primaryLimit?.secondary?.usedPercent).toBe(35);
    expect(usage.limits).toHaveLength(1);
  });

  it('retains a legacy overall quota when the keyed map contains only a specialized bucket', () => {
    const usage = codexUsageFromRateLimitsRead({
      rateLimits: { limitId: 'codex', secondary: { usedPercent: 10, windowDurationMins: 10080 } },
      rateLimitsByLimitId: { codex_bengalfox: { primary: { usedPercent: 90, windowDurationMins: 300 } } }
    });
    expect(usage.primaryLimit).toMatchObject({ id: 'codex', secondary: { usedPercent: 10 } });
    expect(usage.limits.map(limit => limit.id)).toEqual(['codex', 'codex_bengalfox']);
  });

  it("maps Codex primary and weekly windows into remaining percentages", () => {
    const usage = codexUsageFromRateLimitsRead(
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: 1777292438
          },
          secondary: {
            usedPercent: 19,
            windowDurationMins: 10080,
            resetsAt: 1777536841
          },
          planType: "prolite"
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: 1777292438
            },
            secondary: {
              usedPercent: 19,
              windowDurationMins: 10080,
              resetsAt: 1777536841
            },
            planType: "prolite"
          }
        }
      },
      "2026-04-27T10:00:00.000Z"
    );

    expect(usage.status).toBe("available");
    expect(usage.primaryLimit?.primary).toMatchObject({
      label: "5-hour",
      usedPercent: 10,
      remainingPercent: 90
    });
    expect(usage.primaryLimit?.secondary).toMatchObject({
      label: "Weekly",
      usedPercent: 19,
      remainingPercent: 81
    });
  });

  it("updates an existing limit from live app-server notifications", () => {
    const usage = codexUsageFromRateLimitsUpdated(
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 95,
            windowDurationMins: 300,
            resetsAt: 1777292438
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 10080,
            resetsAt: 1777536841
          },
          rateLimitReachedType: "rate_limit_reached"
        }
      },
      emptyCodexUsage(),
      "2026-04-27T10:05:00.000Z"
    );

    expect(usage.primaryLimit?.primary?.remainingPercent).toBe(5);
    expect(usage.primaryLimit?.rateLimitReachedType).toBe("rate_limit_reached");
  });
});
