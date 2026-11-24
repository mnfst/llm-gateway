import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';

const GITHUB_REPO = 'mnfst/llm-gateway';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cachedStars: number | null = null;
let cachedAt = 0;

@Controller('api/v1')
export class GithubController {
  @Public()
  @Get('github/stars')
  async getStars(): Promise<{ stars: number | null }> {
    if (cachedStars !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
      return { stars: cachedStars };
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!res.ok) {
        return { stars: cachedStars };
      }
      const data = (await res.json()) as { stargazers_count?: number };
      if (typeof data.stargazers_count === 'number') {
        cachedStars = data.stargazers_count;
        cachedAt = Date.now();
      }
    } catch {
      // Return stale cache or null on failure
    }

    return { stars: cachedStars };
  }
}
