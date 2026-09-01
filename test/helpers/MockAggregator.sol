// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A Chainlink AggregatorV3 proxy stand-in with every field a test needs to break independently.
///
/// MoleOrders reads exactly two selectors — `decimals()` and `latestRoundData()` — and validates six
/// conditions over them. Each condition needs a way to be violated ALONE, or a test proves only that
/// "something was wrong" rather than that a specific guard fired. So every field is settable and the two
/// non-field failure modes (a reverting proxy and a truncated return) have their own switches.
///
/// `setAnswer` is the honest-life path: it bumps the round and stamps `updatedAt` to now, which is what a
/// real transmission does. The setters below it each break exactly one thing and touch nothing else.
contract MockAggregator {
    uint8 public decimals;

    uint256 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint256 public answeredInRound;

    /// @dev The proxy itself reverts. Distinct from any bad VALUE it could report.
    bool public down;
    /// @dev The proxy answers with fewer than five words — a shape `abi.decode` cannot safely read.
    bool public truncated;

    error AggregatorDown();

    constructor(uint8 _decimals, int256 _answer) {
        decimals = _decimals;
        roundId = 1;
        answeredInRound = 1;
        answer = _answer;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    /* ------------------------------------------------------------------ the honest transmission path */

    /// @dev A new round at the current time — what a live feed does on deviation or heartbeat.
    function setAnswer(int256 a) external {
        roundId += 1;
        answeredInRound = roundId;
        answer = a;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    /// @dev Re-publish the same price now. Keeps the feed fresh without moving the market.
    function stamp() external {
        roundId += 1;
        answeredInRound = roundId;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    /* ------------------------------------------------------ one broken thing at a time, from here down */

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setRawAnswer(int256 a) external {
        answer = a;
    }

    function setRounds(uint256 _roundId, uint256 _answeredInRound) external {
        roundId = _roundId;
        answeredInRound = _answeredInRound;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setDown(bool v) external {
        down = v;
    }

    function setTruncated(bool v) external {
        truncated = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (down) revert AggregatorDown();
        if (truncated) {
            assembly {
                mstore(0x00, 1)
                return(0x00, 0x40)
            }
        }
        return (uint80(roundId), answer, startedAt, updatedAt, uint80(answeredInRound));
    }
}

/// @notice An aggregator whose `roundId` and `answeredInRound` words carry DIRTY HIGH BITS — every bit
///         above the 80th set — while the price itself is perfectly good and current.
///
/// This is the shape that decides how MoleOrders must decode. `abi.decode(ret, (uint80, ...))` REVERTS on
/// a word that does not fit the narrow type, and that revert would escape straight out of `anchorStatus`
/// and `fillable`, which are required never to revert. Decoding into uint256 and comparing there cannot be
/// tripped this way, and the comparison it needs (`answeredInRound >= roundId`) is exact in the wide type.
contract DirtyRoundAggregator {
    uint8 public constant decimals = 8;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 ts = block.timestamp;
        assembly {
            mstore(0x00, not(0)) // roundId: all 256 bits set
            mstore(0x20, 100000000) // answer: 1.00000000
            mstore(0x40, ts) // startedAt
            mstore(0x60, ts) // updatedAt: current, so the only thing wrong is the width
            mstore(0x80, not(0)) // answeredInRound: all 256 bits set, so >= roundId holds
            return(0x00, 0xa0)
        }
    }
}
