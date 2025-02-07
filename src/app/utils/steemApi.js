import { api } from '@steemit/steem-js';
import { LIQUID_TOKEN_UPPERCASE, SCOT_TAG } from 'app/client_config';
import stateCleaner from 'app/redux/stateCleaner';
import axios from 'axios';
import SSC from 'sscjs';

const ssc = new SSC('https://api.steem-engine.com/rpc');

async function callApi(url, params) {
    return await axios({
        url,
        method: 'GET',
        params,
    })
        .then(response => {
            return response.data;
        })
        .catch(err => {
            console.error(`Could not fetch data, url: ${url}`);
            return {};
        });
}

async function getSteemEngineAccountHistoryAsync(account) {
    return callApi('https://api.steem-engine.com/accounts/history', {
        account,
        limit: 100,
        offset: 0,
        type: 'user',
        symbol: LIQUID_TOKEN_UPPERCASE,
        v: new Date().getTime(),
    });
}

export async function getScotDataAsync(path, params) {
    return callApi(`https://scot-api.steem-engine.com/${path}`, params);
}

async function getAuthorRep(feedData) {
    const authors = feedData.map(d => d.author);
    const authorRep = {};
    (await api.getAccountsAsync(authors)).forEach(a => {
        authorRep[a.name] = a.reputation;
    });
    return authorRep;
}

async function fetchMissingData(tag, feedType, state, feedData) {
    if (!state.content) {
        state.content = {};
    }
    const missingKeys = feedData
        .filter(d => d.desc == null || d.children == null)
        .map(d => d.authorperm.substr(1))
        .filter(k => !state.content[k]);
    const missingContent = await Promise.all(
        missingKeys.map(k => {
            const authorPermlink = k.split('/');
            console.log('Unexpected missing: ' + authorPermlink);
            return api.getContentAsync(authorPermlink[0], authorPermlink[1]);
        })
    );
    missingContent.forEach(c => {
        state.content[`${c.author}/${c.permlink}`] = c;
    });

    if (!state.discussion_idx) {
        state.discussion_idx = {};
    }
    const discussionIndex = [];
    const filteredContent = {};
    const authorRep = await getAuthorRep(feedData);
    feedData.forEach(d => {
        const key = d.authorperm.substr(1);
        if (!state.content[key]) {
            filteredContent[key] = {
                author_reputation: authorRep[d.author],
                body: d.desc,
                body_length: d.desc.length,
                permlink: d.authorperm.split('/')[1],
                category: d.tags.split(',')[0],
                children: d.children,
                replies: [], // intentional
            };
        } else {
            filteredContent[key] = state.content[key];
        }
        Object.assign(filteredContent[key], d);
        filteredContent[key].scotData = {};
        filteredContent[key].scotData[LIQUID_TOKEN_UPPERCASE] = d;

        discussionIndex.push(key);
    });
    state.content = filteredContent;
    if (state.discussion_idx[tag]) {
        state.discussion_idx[tag][feedType] = discussionIndex;
    }
}

export async function attachScotData(url, state) {
    let urlParts = url.match(
        /^[\/]?(trending|hot|created|promoted)($|\/$|\/([^\/]+)\/?$)/
    );
    if (urlParts) {
        const feedType = urlParts[1];
        const tag = urlParts[3] || '';
        const discussionQuery = {
            token: LIQUID_TOKEN_UPPERCASE,
            limit: 20,
        };
        if (tag) {
            discussionQuery.tag = tag;
        }
        // first call feed.
        let feedData = await getScotDataAsync(
            `get_discussions_by_${feedType}`,
            discussionQuery
        );
        await fetchMissingData(tag, feedType, state, feedData);
        return;
    }

    urlParts = url.match(/^[\/]?@([^\/]+)\/transfers[\/]?$/);
    if (urlParts) {
        const account = urlParts[1];
        const [
            tokenBalances,
            tokenStatuses,
            transferHistory,
        ] = await Promise.all([
            ssc.findOne('tokens', 'balances', {
                account,
                symbol: LIQUID_TOKEN_UPPERCASE,
            }),
            getScotDataAsync(`@${account}`, { v: new Date().getTime() }),
            getSteemEngineAccountHistoryAsync(account),
        ]);
        if (tokenBalances) {
            state.accounts[account].token_balances = tokenBalances;
        }
        if (tokenStatuses && tokenStatuses[LIQUID_TOKEN_UPPERCASE]) {
            state.accounts[account].token_status =
                tokenStatuses[LIQUID_TOKEN_UPPERCASE];
        }
        if (transferHistory) {
            // Reverse to show recent activity first
            state.accounts[
                account
            ].transfer_history = transferHistory.reverse();
        }
        return;
    }

    /* Not yet robust (no resteems here, will yield inconsistent behavior?). also need to add to authors[..]/feed.
    urlParts = url.match(/^[\/]?@([^\/]+)\/feed[\/]?$/);
    if (urlParts) {
        const account = urlParts[1];
        let feedData = await getScotDataAsync(
            'get_feed',
            {
                token: LIQUID_TOKEN_UPPERCASE,
                account,
                limit: 20,
            }
        );
        await fetchMissingData(account, '', state, feedData);
        return;
    }
    */

    if (state.content) {
        await Promise.all(
            Object.entries(state.content)
                .filter(entry => {
                    return entry[0].match(/[a-z0-9\.-]+\/.*?/);
                })
                .map(async entry => {
                    const k = entry[0];
                    const v = entry[1];
                    // Fetch SCOT data
                    const scotData = await getScotDataAsync(`@${k}`);
                    Object.assign(
                        state.content[k],
                        scotData[LIQUID_TOKEN_UPPERCASE]
                    );
                    state.content[k].scotData = scotData;
                })
        );
        const filteredContent = {};
        Object.entries(state.content)
            .filter(
                entry =>
                    entry[1].scotData &&
                    entry[1].scotData[LIQUID_TOKEN_UPPERCASE]
            )
            .forEach(entry => {
                filteredContent[entry[0]] = entry[1];
            });
        state.content = filteredContent;
    }
}

export async function getContentAsync(author, permlink) {
    const content = await api.getContentAsync(author, permlink);
    const scotData = await getScotDataAsync(`@${author}/${permlink}`);
    // Do not assign scot data directly, or vote count will not show
    // due to delay in steemd vs scot bot.
    //Object.assign(content, scotData[LIQUID_TOKEN_UPPERCASE]);
    content.scotData = scotData;

    return content;
}

export async function getStateAsync(url) {
    // strip off query string
    const path = url.split('?')[0];

    const raw = await api.getStateAsync(path);
    await attachScotData(url, raw);

    const cleansed = stateCleaner(raw);

    return cleansed;
}

export async function fetchFeedDataAsync(call_name, ...args) {
    const fetchSize = args[0].limit;
    let feedData;
    // To indicate if there are no further pages in feed.
    let endOfData;
    // To indicate last fetched value from API.
    let lastValue;

    const callNameMatch = call_name.match(
        /getDiscussionsBy(Trending|Hot|Created|Promoted)Async/
    );
    if (callNameMatch) {
        const order = callNameMatch[1].toLowerCase();
        const discussionQuery = {
            ...args[0],
            token: LIQUID_TOKEN_UPPERCASE,
        };
        if (!discussionQuery.tag) {
            // If empty string, remove from query.
            delete discussionQuery.tag;
        }
        feedData = await getScotDataAsync(
            `get_discussions_by_${order}`,
            discussionQuery
        );
        feedData = await Promise.all(
            feedData.map(async scotData => {
                const authorPermlink = scotData.authorperm.substr(1).split('/');
                let content;
                if (scotData.desc == null || scotData.children == null) {
                    content = await api.getContentAsync(
                        authorPermlink[0],
                        authorPermlink[1]
                    );
                } else {
                    content = {
                        body: scotData.desc,
                        body_length: scotData.desc.length,
                        permlink: scotData.authorperm.split('/')[1],
                        category: scotData.tags.split(',')[0],
                        children: scotData.children,
                        replies: [], // intentional
                    };
                }
                Object.assign(content, scotData);
                content.scotData = {};
                content.scotData[LIQUID_TOKEN_UPPERCASE] = scotData;
                return content;
            })
        );
        // fill in author rep
        const authorRep = await getAuthorRep(feedData);
        feedData.forEach(d => {
            d.author_reputation = authorRep[d.author];
        });

        // this indicates no further pages in feed.
        endOfData = feedData.length < fetchSize;
        lastValue = feedData.length > 0 ? feedData[feedData.length - 1] : null;
    } else {
        feedData = await api[call_name](...args);
        feedData = await Promise.all(
            feedData.map(async post => {
                const k = `${post.author}/${post.permlink}`;
                const scotData = await getScotDataAsync(`@${k}`);
                Object.assign(post, scotData[LIQUID_TOKEN_UPPERCASE]);
                post.scotData = scotData;
                return post;
            })
        );
        // endOfData check and lastValue setting should go before any filtering,
        endOfData = feedData.length < fetchSize;
        lastValue = feedData.length > 0 ? feedData[feedData.length - 1] : null;
        feedData = feedData.filter(
            post => post.scotData && post.scotData[LIQUID_TOKEN_UPPERCASE]
        );
    }
    return { feedData, endOfData, lastValue };
}
