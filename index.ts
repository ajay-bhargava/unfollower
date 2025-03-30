/// <reference lib="dom" />
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import moment from 'moment';
import { standardDeviation } from 'simple-statistics';
import { ElementHandle } from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

// Configure puppeteer with stealth plugin
puppeteer.use(StealthPlugin());

// Helper function to add random delays
const randomDelay = async (min = 2000, max = 5000) => {
    const delay = Math.floor(Math.random() * (max - min) + min);
    await new Promise(resolve => setTimeout(resolve, delay));
};

// Helper function to extract date from tweet
const extractTweetDate = (dateString: string): Date => {
    return new Date(dateString);
};

interface FollowerData {
    username: string;
    lastTweetDates: Date[];
    averageDate: Date;
    stdDev: number;
}

interface UnfollowCandidate {
    username: string;
    profileUrl: string;
    monthsInactive: number;
    tweetPattern: 'irregular' | 'consistently_inactive';
}

// Add prompt function for Node environments
const prompt = (question: string): Promise<string> => {
    const readline = require('node:readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        readline.question(question, (answer: string) => {
            readline.close();
            resolve(answer);
        });
    });
};

// Modify the export function to handle incremental updates
const createOrUpdateMarkdown = (
    following: FollowerData[],
    noPostsUsers: string[],
    unfollowCandidates: UnfollowCandidate[],
    totalToProcess: number,
    filename: string
) => {
    let markdown = "# Twitter Following Audit Report\n\n";
    markdown += `*Generated on ${new Date().toLocaleString()}*\n`;
    markdown += `*Last updated: ${new Date().toLocaleString()}*\n\n`;
    markdown += `**Progress: ${following.length + noPostsUsers.length}/${totalToProcess} accounts processed**\n\n`;

    // Active Users Section
    markdown += "## Users with Recent Activity\n\n";
    markdown += "| Username | Last Posts | Tweet Pattern (days) |\n";
    markdown += "|----------|------------|--------------------|\n";
    for (const user of following) {
        markdown += `| [@${user.username}](https://twitter.com/${user.username}) | ${user.lastTweetDates.map(date => 
            date.toLocaleDateString()).join(', ')} | ${Math.round(user.stdDev * 100) / 100} |\n`;
    }

    // No Posts Section
    markdown += "\n## Users with No Recent Posts\n\n";
    for (const username of noPostsUsers) {
        markdown += `- [@${username}](https://twitter.com/${username})\n`;
    }

    // Unfollow Candidates Section
    markdown += "\n## Recommended Unfollow Candidates\n\n";
    markdown += "| Username | Months Inactive | Pattern |\n";
    markdown += "|----------|-----------------|----------|\n";
    for (const candidate of unfollowCandidates) {
        markdown += `| [@${candidate.username}](${candidate.profileUrl}) | ${candidate.monthsInactive} | ${candidate.tweetPattern} |\n`;
    }

    // Summary Section
    markdown += "\n## Current Summary\n\n";
    markdown += `- Accounts processed: ${following.length + noPostsUsers.length}/${totalToProcess}\n`;
    markdown += `- Accounts with posts: ${following.length}\n`;
    markdown += `- Accounts with no posts: ${noPostsUsers.length}\n`;
    markdown += `- Recommended unfollows: ${unfollowCandidates.length}\n`;

    // Write to file
    fs.writeFileSync(filename, markdown);
};

// Modify the main function to use incremental updates
async function main() {
    try {
        // Get username from user
        const username = await prompt('Enter your X (Twitter) username: ');
        if (!username) {
            throw new Error('Username is required');
        }

        // Get markdown filename from user
        let markdownFilename = await prompt('Enter the markdown filename (press Enter for auto-generated name): ');
        if (!markdownFilename) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            markdownFilename = `twitter-audit-${timestamp}.md`;
        } else if (!markdownFilename.endsWith('.md')) {
            markdownFilename += '.md';
        }

        console.log(`Results will be saved to: ${markdownFilename}`);

        // Launch browser
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized']
        });

        const page = await browser.newPage();
        
        // Navigate to Twitter login
        await page.goto('https://twitter.com/login');
        console.log('\nPlease log in to X (Twitter) manually in the browser window.');
        console.log('Once you are logged in and can see your feed, press Enter to continue...');
        
        // Wait for user to confirm they've logged in
        await prompt('');
        
        // Additional verification that we're logged in by checking the URL
        const currentUrl = page.url();
        if (currentUrl.includes('login')) {
            throw new Error('Login was not successful. Please run the script again and ensure you are logged in before continuing.');
        }
        
        // Navigate to following list (instead of followers)
        console.log("Navigating to following list...");
        await page.goto(`https://twitter.com/${username}/following`);
        await randomDelay();

        // Scroll and collect all following links
        console.log("Collecting following links...");
        const followingLinks: { username: string; profileUrl: string }[] = [];
        let previousLength = 0;
        let noNewLinksCount = 0;
        
        // Keep scrolling until we don't find new links for 3 consecutive attempts
        while (noNewLinksCount < 3) {
            // Collect following links after each scroll
            const newLinks = await page.$$eval(
                'section[role="region"] a[role="link"]',
                (elements) => elements
                    .filter(el => {
                        const href = el.getAttribute('href');
                        // Filter out non-profile links
                        return href && 
                               !href.includes('/followers') && 
                               !href.includes('/following') && 
                               !href.includes('/status') &&
                               !href.includes('/photo') &&
                               href.startsWith('/');
                    })
                    .map(el => ({
                        username: el.getAttribute('href')?.replace('/', '') || '',
                        profileUrl: `https://twitter.com${el.getAttribute('href')}`
                    }))
            );

            // Add new unique links
            for (const link of newLinks) {
                if (!followingLinks.some(existing => existing.username === link.username)) {
                    followingLinks.push(link);
                }
            }

            // Check if we found new links
            if (followingLinks.length === previousLength) {
                noNewLinksCount++;
            } else {
                noNewLinksCount = 0;
                previousLength = followingLinks.length;
            }

            console.log(`Found ${followingLinks.length} following so far...`);
            
            // Scroll down
            await page.evaluate(() => window.scrollBy(0, 1000));
            await randomDelay(1000, 2000);
        }

        console.log(`Found ${followingLinks.length} total following. Processing all accounts...`);
        const following: FollowerData[] = [];
        const noPostsUsers: string[] = [];
        const unfollowCandidates: UnfollowCandidate[] = [];
        
        // Initial markdown creation
        createOrUpdateMarkdown(following, noPostsUsers, unfollowCandidates, followingLinks.length, markdownFilename);
        
        // Process all following
        for (const user of followingLinks) {
            await randomDelay();
            console.log(`Processing ${user.username} (${following.length + noPostsUsers.length + 1}/${followingLinks.length})...`);

            try {
                // Visit user's profile
                await page.goto(user.profileUrl);
                await randomDelay();

                // Get their latest tweets (excluding replies)
                const tweetDates = await page.$$eval(
                    '[data-testid="tweet"] time',
                    (elements: HTMLTimeElement[]) => elements.slice(0, 3).map((el: HTMLTimeElement) => el.getAttribute('datetime'))
                );

                const dates = tweetDates
                    .filter((date: string | null): date is string => date !== null)
                    .map((date: string) => extractTweetDate(date));

                if (dates.length > 0) {
                    const avgDate = new Date(
                        dates.reduce((sum: number, date: Date) => sum + date.getTime(), 0) / dates.length
                    );
                    
                    const stdDev = dates.length > 1 
                        ? standardDeviation(dates.map((d: Date) => d.getTime()))
                        : 0;

                    // Convert stdDev from milliseconds to days
                    const stdDevInDays = stdDev / (1000 * 60 * 60 * 24);

                    following.push({
                        username: user.username,
                        lastTweetDates: dates,
                        averageDate: avgDate,
                        stdDev: stdDevInDays
                    });

                    // Check if this is an unfollow candidate
                    const monthsSinceLastTweet = moment().diff(moment(avgDate), 'months');
                    if (monthsSinceLastTweet > 3) {
                        const tweetPattern = stdDevInDays > 30 ? 'irregular' : 'consistently_inactive';
                        unfollowCandidates.push({
                            username: user.username,
                            profileUrl: `https://twitter.com/${user.username}`,
                            monthsInactive: monthsSinceLastTweet,
                            tweetPattern
                        });
                    }
                } else {
                    noPostsUsers.push(user.username);
                }

                // Update markdown file after each user
                createOrUpdateMarkdown(following, noPostsUsers, unfollowCandidates, followingLinks.length, markdownFilename);

            } catch (error) {
                console.error(`Error processing ${user.username}:`, error);
                // Still update markdown to show progress
                createOrUpdateMarkdown(following, noPostsUsers, unfollowCandidates, followingLinks.length, markdownFilename);
            }
        }

        // Final console output
        console.log(`\nDetailed report has been exported to: ${markdownFilename}`);
        console.log('You can open this file in any markdown viewer to review and click through the profiles.');
        
        await browser.close();
        console.log('Process completed successfully!');
        
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

main();