/**
 * Resource group detection: identify buckets (groups) from repeated FEAT values.
 * Mutates projects in place with resourceGroup* fields.
 *
 * Three group types:
 *
 * 1.  PEER BUCKET — Multiple rows share a FEAT, each with its own capacity.
 *     All schedule independently. Visual: dotted wrapper around bars.
 *     Fields set: resourceGroupId, resourceGroupName. No parent/child.
 *
 * 2a. POOL (IAMv2-style) — One row got the pool-level numbers from a merged
 *     Excel cell; the rest have zero resources but their own sizing and deps.
 *     All rows (including the first) are sub-projects that share the pool.
 *     Pool-level data is extracted into a synthetic _pool record; the first
 *     row is demoted to a normal sub-project. Each sub-project's duration
 *     comes from its own sizingLabel via monthsFromSizingBand().
 *
 * 2b. Rows within a 2a group that have their own capacity (e.g. "UI Workflow
 *     integration" with 2 people) are treated as Type 1 peers — they schedule
 *     independently outside the pool.
 *
 * @module resource-groups
 */

import { logger } from './logger.js';
import { monthsFromSizingBand } from './sizing.js';

/**
 * Detect resource groups by repeated FEAT value (column B).
 * Case-insensitive matching (IAMv2/IAMV2 merge).
 * Only continuation rows (rowNumber >= 9000) inherit the previous row's FEAT.
 * Rows with their own Sl No and empty FEAT are standalone.
 *
 * @param {Array<object>} projects - Projects with rowNumber, feat, summary, totalResources, durationMonths, dri.
 */
export function detectResourceGroups(projects) {
  /* Clear stale group fields; restore original totalResources if previously demoted */
  for (const p of projects) {
    if (p._originalTotalResources != null) {
      p.totalResources = p._originalTotalResources;
      p.totalPersonMonthsNum = p._originalTotalPersonMonthsNum ?? p.totalPersonMonthsNum;
      p.durationMonths = p._originalDurationMonths ?? p.durationMonths;
    }
    delete p._originalTotalResources;
    delete p._originalTotalPersonMonthsNum;
    delete p._originalDurationMonths;
    delete p.resourceGroupId;
    delete p.resourceGroupName;
    delete p.resourceGroupChildRows;
    delete p.isResourceGroupChild;
    delete p.resourceGroupParentRow;
    delete p.resourceGroupRole;
    delete p._pool;
    delete p._poolSchedule;
    delete p._poolBudgetMonths;
    delete p._poolChainMonths;
  }

  let lastFeatKey = '';
  const bucketByFeat = new Map();

  for (const p of projects) {
    const featVal = (p.feat || '').trim();
    const isContinuationRow = p.rowNumber >= 9000;
    const featKey = featVal ? featVal.toLowerCase() : (isContinuationRow ? lastFeatKey : '');
    if (featVal) lastFeatKey = featKey;
    if (!featKey) continue;
    if (!bucketByFeat.has(featKey)) bucketByFeat.set(featKey, []);
    bucketByFeat.get(featKey).push(p);
  }

  for (const [featKey, members] of bucketByFeat) {
    if (members.length < 2) continue;

    const withResources = members.filter(p => Number(p.totalResources || 0) > 0);
    const withoutResources = members.filter(p => Number(p.totalResources || 0) <= 0);
    const bucketName = (members[0].feat || '').trim() || featKey;

    const hasChildren = withoutResources.length > 0;
    const hasParent = withResources.length >= 1;

    if (hasParent && hasChildren) {
      /* TYPE 2a POOL: The row with resources is just the first row that
         inherited the merged Excel cell — it's a sub-project like the rest.
         Extract pool-level data, then demote it to a sub-project. */
      const poolRow = withResources.length === 1
        ? withResources[0]
        : withResources.reduce((a, b) => (Number(a.totalResources || 0) >= Number(b.totalResources || 0) ? a : b));
      const peers = withResources.filter(p => p !== poolRow);
      const subProjects = [poolRow, ...withoutResources];
      const subProjectRows = subProjects.map(c => c.rowNumber);
      const groupId = `pool-${poolRow.rowNumber}`;

      const pool = {
        totalResources: Number(poolRow.totalResources || 0),
        totalPersonMonthsNum: poolRow.totalPersonMonthsNum ?? null,
        durationMonths: poolRow.durationMonths ?? 0,
      };

      /* Demote poolRow: strip pool-level numbers, keep its own sizing/deps.
         Save originals so re-detection works after serialization round-trips. */
      poolRow._originalTotalResources = pool.totalResources;
      poolRow._originalTotalPersonMonthsNum = pool.totalPersonMonthsNum;
      poolRow._originalDurationMonths = pool.durationMonths;
      const poolRowSizingMonths = monthsFromSizingBand(poolRow.sizingLabel);
      poolRow.totalResources = 0;
      poolRow.totalPersonMonthsNum = null;
      poolRow.durationMonths = poolRowSizingMonths > 0 ? poolRowSizingMonths : (poolRow.durationMonths ?? 0);

      poolRow.resourceGroupId = groupId;
      poolRow.resourceGroupName = bucketName;
      poolRow.resourceGroupRole = 'pool-parent';
      poolRow.resourceGroupChildRows = subProjectRows.filter(r => r !== poolRow.rowNumber);
      poolRow._pool = pool;

      for (const sub of withoutResources) {
        sub.resourceGroupId = groupId;
        sub.resourceGroupName = bucketName;
        sub.isResourceGroupChild = true;
        sub.resourceGroupParentRow = poolRow.rowNumber;
      }

      /* TYPE 2b: rows with their own capacity are peers — scheduled independently */
      for (const peer of peers) {
        peer.resourceGroupId = groupId;
        peer.resourceGroupName = bucketName;
      }

      logger.debug('resource-groups: pool (2a)', bucketName,
        'poolRow', poolRow.rowNumber, 'pool', pool,
        'subProjects', subProjects.length, 'peers (2b)', peers.length);
    } else {
      /* TYPE 1 PEER BUCKET: all rows have resources — schedule independently.
         Only set groupId/Name for visual wrapper. No parent/child. */
      const groupId = 'bucket-' + (bucketName || featKey)
        .replace(/\s+/g, '-').replace(/[^\w\-]/g, '').slice(0, 60)
        || `bucket-${members[0].rowNumber}`;

      for (const p of members) {
        p.resourceGroupId = groupId;
        p.resourceGroupName = bucketName;
      }
      logger.debug('resource-groups: peer bucket', bucketName, 'members', members.length);
    }
  }
}
