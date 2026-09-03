import type { Category } from "./types";

/**
 * Every feed here was checked for a 200 + parseable <item> list before it went in.
 * BBC redirects http -> https, so the https URLs are the ones that work.
 */
export const FEEDS: Record<Category, { url: string; source: string }[]> = {
  top: [
    { url: "https://feeds.bbci.co.uk/news/rss.xml", source: "BBC News" },
    { url: "https://feeds.npr.org/1001/rss.xml", source: "NPR" },
  ],
  world: [
    { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC World" },
    { url: "https://www.theguardian.com/world/rss", source: "The Guardian" },
    { url: "https://www.aljazeera.com/xml/rss/all.xml", source: "Al Jazeera" },
    { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", source: "New York Times" },
  ],
  business: [
    { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC Business" },
    { url: "https://www.cnbc.com/id/10001147/device/rss/rss.html", source: "CNBC" },
    { url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", source: "WSJ Markets" },
  ],
  technology: [
    { url: "https://feeds.bbci.co.uk/news/technology/rss.xml", source: "BBC Tech" },
    { url: "https://techcrunch.com/feed/", source: "TechCrunch" },
    { url: "http://feeds.arstechnica.com/arstechnica/index", source: "Ars Technica" },
    { url: "https://hnrss.org/frontpage", source: "Hacker News" },
  ],
  science: [
    { url: "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml", source: "NYT Science" },
  ],
  sport: [
    { url: "https://www.theguardian.com/uk/sport/rss", source: "Guardian Sport" },
  ],
  culture: [
    { url: "https://www.theguardian.com/uk/culture/rss", source: "Guardian Culture" },
  ],
  startups: [
    { url: "https://techcrunch.com/category/startups/feed/", source: "TechCrunch" },
    { url: "https://sifted.eu/feed", source: "Sifted" },
    { url: "https://feeds.bloomberg.com/technology/news.rss", source: "Bloomberg Tech" },
    { url: "https://www.eu-startups.com/feed/", source: "EU-Startups" },
    { url: "https://venturebeat.com/feed/", source: "VentureBeat" },
  ],
  television: [
    { url: "https://variety.com/v/tv/feed/", source: "Variety" },
    { url: "https://deadline.com/v/tv/feed/", source: "Deadline" },
    { url: "https://www.hollywoodreporter.com/c/tv/feed/", source: "Hollywood Reporter" },
    { url: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", source: "BBC Entertainment" },
  ],
};
