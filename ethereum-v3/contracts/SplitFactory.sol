// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EthSplit.sol";

/**
 * @title SplitFactory
 * @notice Factory contract that deploys and tracks EthSplit instances
 * @dev Demonstrates production-grade factory patterns:
 *      - Paginated reads for scalable discovery
 *      - Event-driven tracking for off-chain indexers
 *      - Deployment metadata for frontend integration
 *
 * @dev Security notes:
 *      - This contract is for demonstration on Sepolia testnet only
 *      - It has NOT received a professional external audit
 *      - Anyone can create splits; there are no privileged roles
 */
contract SplitFactory {
    /// @notice Semantic version of the factory contract
    string public constant VERSION = "3.0.0";

    /// @notice Default page size for paginated reads
    uint256 public constant DEFAULT_PAGE_SIZE = 20;

    /// @notice Maximum page size to prevent excessive gas usage
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @dev Struct to track split deployment metadata
    struct SplitInfo {
        /// @notice Address of the deployed EthSplit contract
        address splitAddress;
        /// @notice Address that manages the split
        address manager;
        /// @notice Human-readable title
        string title;
        /// @notice Block number when the split was created
        uint256 createdAtBlock;
        /// @notice Timestamp when the split was created
        uint256 createdAtTimestamp;
    }

    /// @dev Internal array storing all split deployments
    SplitInfo[] private splits;

    /// @dev Mapping to check if an address was deployed by this factory
    mapping(address => bool) public isFactoryDeployed;

    // ============ CUSTOM ERRORS ============

    /// @notice Thrown when trying to create a split with an empty title
    error EmptyTitle();

    /// @notice Thrown when pagination offset is out of bounds
    /// @param offset The requested offset
    /// @param totalSplits The total number of splits available
    error InvalidOffset(uint256 offset, uint256 totalSplits);

    /// @notice Thrown when requested page size exceeds maximum
    /// @param requestedSize The requested page size
    /// @param maxSize The maximum allowed page size
    error PageSizeTooLarge(uint256 requestedSize, uint256 maxSize);

    // ============ EVENTS ============

    /**
     * @notice Emitted when a new EthSplit is created via the factory
     * @param splitAddress Address of the deployed EthSplit contract
     * @param manager Address that owns and manages the new split
     * @param title Human-readable title of the split
     * @param index Global index of the split in the factory
     * @param createdAtBlock Block number at creation time
     * @param createdAtTimestamp Unix timestamp at creation time
     */
    event SplitCreated(
        address indexed splitAddress,
        address indexed manager,
        string title,
        uint256 indexed index,
        uint256 createdAtBlock,
        uint256 createdAtTimestamp
    );

    // ============ EXTERNAL FUNCTIONS ============

    /**
     * @notice Creates a new EthSplit contract
     * @param title Human-readable name for the split
     * @return splitAddress The address of the newly deployed contract
     * @dev The caller becomes the manager of the new split
     *      - Anyone can create a split (no privileged access)
     *      - The deployed contract is tracked in the factory
     */
    function createSplit(
        string memory title
    ) external returns (address splitAddress) {
        if (bytes(title).length == 0) {
            revert EmptyTitle();
        }

        // Deploy new EthSplit with caller as manager
        EthSplit split = new EthSplit(
            title,
            msg.sender
        );

        splitAddress = address(split);

        // Track the deployment
        SplitInfo memory info = SplitInfo({
            splitAddress: splitAddress,
            manager: msg.sender,
            title: title,
            createdAtBlock: block.number,
            createdAtTimestamp: block.timestamp
        });

        uint256 index = splits.length;
        splits.push(info);
        isFactoryDeployed[splitAddress] = true;

        emit SplitCreated(
            splitAddress,
            msg.sender,
            title,
            index,
            block.number,
            block.timestamp
        );

        return splitAddress;
    }

    /**
     * @notice Returns paginated list of splits
     * @param offset Starting index (0-based)
     * @param limit Maximum number of items to return
     * @return results Array of SplitInfo structs
     * @return totalSplits Total number of splits created
     * @dev Pagination prevents unbounded gas usage with large datasets
     */
    function getSplitsPaginated(
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            SplitInfo[] memory results,
            uint256 totalSplits
        )
    {
        totalSplits = splits.length;

        if (offset > totalSplits) {
            revert InvalidOffset(offset, totalSplits);
        }

        if (limit > MAX_PAGE_SIZE) {
            revert PageSizeTooLarge(limit, MAX_PAGE_SIZE);
        }

        // Calculate actual return size (handle partial pages)
        uint256 end = offset + limit;
        if (end > totalSplits) {
            end = totalSplits;
        }

        uint256 resultSize = end - offset;
        results = new SplitInfo[](resultSize);

        for (uint256 i = 0; i < resultSize; i++) {
            results[i] = splits[offset + i];
        }

        return (results, totalSplits);
    }

    /**
     * @notice Returns splits using default page size
     * @param offset Starting index (0-based)
     * @return results Array of SplitInfo structs
     * @return totalSplits Total number of splits created
     */
    function getSplits(
        uint256 offset
    )
        external
        view
        returns (
            SplitInfo[] memory results,
            uint256 totalSplits
        )
    {
        uint256 limit = DEFAULT_PAGE_SIZE;

        totalSplits = splits.length;

        if (offset > totalSplits) {
            revert InvalidOffset(offset, totalSplits);
        }

        if (limit > MAX_PAGE_SIZE) {
            revert PageSizeTooLarge(limit, MAX_PAGE_SIZE);
        }

        uint256 end = offset + limit;
        if (end > totalSplits) {
            end = totalSplits;
        }

        uint256 resultSize = end - offset;
        results = new SplitInfo[](resultSize);

        for (uint256 i = 0; i < resultSize; i++) {
            results[i] = splits[offset + i];
        }

        return (results, totalSplits);
    }

    /**
     * @notice Returns the most recently created splits
     * @param count Number of recent splits to return
     * @return results Array of the latest SplitInfo structs
     * @dev Useful for dashboards showing recent activity
     */
    function getRecentSplits(
        uint256 count
    )
        external
        view
        returns (SplitInfo[] memory results)
    {
        if (count > MAX_PAGE_SIZE) {
            revert PageSizeTooLarge(count, MAX_PAGE_SIZE);
        }

        uint256 total = splits.length;
        uint256 start = total > count ? total - count : 0;
        uint256 resultSize = total - start;

        results = new SplitInfo[](resultSize);

        for (uint256 i = 0; i < resultSize; i++) {
            results[i] = splits[start + i];
        }

        return results;
    }

    /**
     * @notice Returns total number of splits created
     * @return uint256 Total split count
     */
    function splitCount()
        external
        view
        returns (uint256)
    {
        return splits.length;
    }

    /**
     * @notice Returns detailed information about a specific split
     * @param index Global index of the split
     * @return splitAddress Address of the split contract
     * @return manager Address of the split manager
     * @return title Title of the split
     * @return createdAtBlock Block when created
     * @return createdAtTimestamp Timestamp when created
     */
    function getSplitInfo(
        uint256 index
    )
        external
        view
        returns (
            address splitAddress,
            address manager,
            string memory title,
            uint256 createdAtBlock,
            uint256 createdAtTimestamp
        )
    {
        if (index >= splits.length) {
            revert InvalidOffset(
                index,
                splits.length
            );
        }

        SplitInfo storage info = splits[index];

        return (
            info.splitAddress,
            info.manager,
            info.title,
            info.createdAtBlock,
            info.createdAtTimestamp
        );
    }

    /**
     * @notice Returns factory metadata for frontend and indexer use
     * @return version Factory contract version
     * @return deployedSplits Total number of splits deployed
     * @return defaultPageSize Default pagination size
     * @return maxPageSize Maximum pagination size
     */
    function getFactoryInfo()
        external
        view
        returns (
            string memory version,
            uint256 deployedSplits,
            uint256 defaultPageSize,
            uint256 maxPageSize
        )
    {
        return (
            VERSION,
            splits.length,
            DEFAULT_PAGE_SIZE,
            MAX_PAGE_SIZE
        );
    }

    /**
     * @notice Checks if an address was deployed by this factory
     * @param splitAddress Address to check
     * @return bool True if deployed by this factory
     * @dev Frontend can use this to validate contract authenticity
     */
    function isDeployedByFactory(
        address splitAddress
    ) external view returns (bool) {
        return isFactoryDeployed[splitAddress];
    }
}
