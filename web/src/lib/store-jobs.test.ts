import { afterEach, describe, expect, it } from "bun:test";
import { jobs as jobsApi } from "./api";
import { useVantage } from "./store";

const originalList = jobsApi.list;
const originalMatches = jobsApi.matches;

afterEach(() => {
  jobsApi.list = originalList;
  jobsApi.matches = originalMatches;
});

describe("loadJobs", () => {
  it("keeps real jobs visible when optional batch scoring fails", async () => {
    const job = {
      id: "00000000-0000-4000-8000-000000000501",
      company: "Relay Labs",
      role_title: "Backend Engineer",
      url: "https://jobs.example.test/backend",
      parsed: {},
      posted_date: "2026-08-08T00:00:00.000Z",
    };
    jobsApi.list = async () => ({ jobs: [job] });
    jobsApi.matches = async () => {
      throw new Error("score projection unavailable");
    };
    useVantage.setState({
      currentResumeId: "resume-store-jobs-fallback",
      apiJobs: [],
      apiJobsLoading: false,
    });

    await useVantage.getState().loadJobs();

    expect(useVantage.getState().apiJobs).toEqual([job]);
    expect(useVantage.getState().apiJobsLoading).toBe(false);
  });
});
