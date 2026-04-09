import { Response } from "express";
import { OngoingJobsResponse, RequestWithAuth } from "./types";
import { getOngoingCrawlsForTeam } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
configDotenv();

export async function ongoingJobsController(
  req: RequestWithAuth<{}, undefined, OngoingJobsResponse>,
  res: Response<OngoingJobsResponse>,
) {
  const crawls = await getOngoingCrawlsForTeam(req.auth.team_id);

  res.status(200).json({
    success: true,
    jobs: crawls.map(x => ({
      id: x.id,
      kind: x.crawlerOptions ? ("crawl" as const) : ("batch_scrape" as const),
      teamId: x.team_id,
      url: x.originUrl ?? null,
      created_at: new Date(x.createdAt || Date.now()).toISOString(),
    })),
  });
}
