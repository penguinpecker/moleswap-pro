// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external payable;
}

contract MoleSwapLiquidityProxy {
    address public owner;
    address public immutable positionManager;

    event LiquidityAdded(
        address indexed user,
        uint256 indexed tokenId,
        address token0,
        address token1,
        uint24 fee,
        uint128 liquidity
    );
    event LiquidityIncreased(
        address indexed user,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
    event LiquidityDecreased(
        address indexed user,
        uint256 indexed tokenId,
        uint128 liquidityRemoved,
        uint256 amount0,
        uint256 amount1
    );
    event FeesCollected(
        address indexed user,
        uint256 indexed tokenId,
        uint256 amount0,
        uint256 amount1
    );
    event PositionBurned(
        address indexed user,
        uint256 indexed tokenId
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address _positionManager) {
        require(_positionManager != address(0), "ZERO_PM");
        positionManager = _positionManager;
        owner = msg.sender;
    }

    struct MintInput {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @notice Mint a new liquidity position. NFT goes directly to msg.sender.
    function mint(MintInput calldata p) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        if (p.amount0Desired > 0) {
            IERC20(p.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
            IERC20(p.token0).approve(positionManager, p.amount0Desired);
        }
        if (p.amount1Desired > 0) {
            IERC20(p.token1).transferFrom(msg.sender, address(this), p.amount1Desired);
            IERC20(p.token1).approve(positionManager, p.amount1Desired);
        }

        (tokenId, liquidity, amount0, amount1) = INonfungiblePositionManager(positionManager).mint(
            INonfungiblePositionManager.MintParams({
                token0: p.token0,
                token1: p.token1,
                fee: p.fee,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                amount0Desired: p.amount0Desired,
                amount1Desired: p.amount1Desired,
                amount0Min: p.amount0Min,
                amount1Min: p.amount1Min,
                recipient: msg.sender,
                deadline: p.deadline
            })
        );

        _refundRemaining(p.token0, p.token1);
        emit LiquidityAdded(msg.sender, tokenId, p.token0, p.token1, p.fee, liquidity);
    }

    struct IncreaseLiquidityInput {
        uint256 tokenId;
        address token0;
        address token1;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @notice Increase liquidity on an existing position.
    /// @dev User must call setApprovalForAll(thisProxy, true) on PositionManager first.
    function increaseLiquidity(IncreaseLiquidityInput calldata p) external returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        if (p.amount0Desired > 0) {
            IERC20(p.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
            IERC20(p.token0).approve(positionManager, p.amount0Desired);
        }
        if (p.amount1Desired > 0) {
            IERC20(p.token1).transferFrom(msg.sender, address(this), p.amount1Desired);
            IERC20(p.token1).approve(positionManager, p.amount1Desired);
        }

        (liquidity, amount0, amount1) = INonfungiblePositionManager(positionManager).increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: p.tokenId,
                amount0Desired: p.amount0Desired,
                amount1Desired: p.amount1Desired,
                amount0Min: p.amount0Min,
                amount1Min: p.amount1Min,
                deadline: p.deadline
            })
        );

        _refundRemaining(p.token0, p.token1);
        emit LiquidityIncreased(msg.sender, p.tokenId, liquidity, amount0, amount1);
    }

    /// @notice Decrease liquidity on a position.
    /// @dev User must call setApprovalForAll(thisProxy, true) on PositionManager first.
    function decreaseLiquidity(
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = INonfungiblePositionManager(positionManager).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            })
        );

        emit LiquidityDecreased(msg.sender, tokenId, liquidity, amount0, amount1);
    }

    /// @notice Collect earned fees from a position.
    /// @dev User must call setApprovalForAll(thisProxy, true) on PositionManager first.
    function collect(
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max
    ) external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = INonfungiblePositionManager(positionManager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: msg.sender,
                amount0Max: amount0Max,
                amount1Max: amount1Max
            })
        );

        emit FeesCollected(msg.sender, tokenId, amount0, amount1);
    }

    /// @notice Burn an empty position NFT.
    /// @dev User must call setApprovalForAll(thisProxy, true) on PositionManager first.
    function burn(uint256 tokenId) external {
        INonfungiblePositionManager(positionManager).burn(tokenId);
        emit PositionBurned(msg.sender, tokenId);
    }

    function _refundRemaining(address token0, address token1) internal {
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        if (bal0 > 0) IERC20(token0).transfer(msg.sender, bal0);
        if (bal1 > 0) IERC20(token1).transfer(msg.sender, bal1);
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    function rescueETH() external onlyOwner {
        (bool sent, ) = payable(owner).call{value: address(this).balance}("");
        require(sent, "TRANSFER_FAILED");
    }

    receive() external payable {}
}
