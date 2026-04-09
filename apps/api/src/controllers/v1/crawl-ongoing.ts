import { Response } from "express";
import {
  OngoingCrawlsResponse,
  RequestWithAuth,
  toNewCrawlerOptions,
} from "./types";
import { getOngoingCrawlsForTeam } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
configDotenv();

export async function ongoingCrawlsController(
  req: RequestWithAuth<{}, undefined, OngoingCrawlsResponse>,
  res: Response<OngoingCrawlsResponse>,
) {
  const crawls = (await getOngoingCrawlsForTeam(req.auth.team_id)).filter(
    x => x.crawlerOptions,
  );

  res.status(200).json({
    success: true,
    crawls: crawls.map(x => ({
      id: x.id,
      teamId: x.team_id,
      url: x.originUrl!,
      created_at: new Date(x.createdAt || Date.now()).toISOString(),
      options: {
        ...toNewCrawlerOptions(x.crawlerOptions),
        scrapeOptions: x.scrapeOptions,
      },
    })),
  });
}
