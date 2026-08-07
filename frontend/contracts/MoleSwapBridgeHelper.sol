// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MoleSwapBridgeHelper
 * @notice Atomic bridge-in + swap for Solana users (1-signature UX)
 * @dev Solves the 1232-byte Solana tx buffer limit by combining wrap+approve+swap
 *      into a single function call. When the Universal Gateway mints PRC-20 to this
 *      contract, it immediately swaps without needing external approval steps.
 *
 * Pattern: Instead of multicall([wrap, approve, swap]) which overflows Solana's
 * buffer, the frontend sends a single call: bridgeAndSwap(tokenIn, tokenOut, ...)
 * The gateway mints bridged tokens directly to this contract, then this contract
 * swaps them atomically.
 *
 * Similar to RamenFi's depositPRC20WithAutoSwap (selector 0x780ad827)
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IWPC {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IMoleSwapFeeRouter {
    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline,
        uint160 sqrtPriceLimitX96
    ) external payable returns (uint256 amountOut);
}

contract MoleSwapBridgeHelper {
    address public owner;
    address public immutable swapRouter;
    address public immutable feeRouter;
    address public immutable wpc;

    // Pre-approved max allowance for routers (gas optimization)
    uint256 private constant MAX_UINT = type(uint256).max;

    event BridgeAndSwap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event BridgeAndSwapMultiHop(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint8 hops
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(
        address _swapRouter,
        address _feeRouter,
        address _wpc
    ) {
        require(_swapRouter != address(0), "ZERO_SWAP_ROUTER");
        require(_feeRouter != address(0), "ZERO_FEE_ROUTER");
        require(_wpc != address(0), "ZERO_WPC");

        swapRouter = _swapRouter;
        feeRouter = _feeRouter;
        wpc = _wpc;
        owner = msg.sender;
    }

    /**
     * @notice Single-hop bridge + swap (atomic, 1 signature for Solana users)
     * @dev Called via Push Chain's universal.sendTransaction with funds parameter.
     *      The gateway mints bridged PRC-20 to this contract before this function
     *      executes, so we can swap immediately without external transferFrom.
     *
     * @param tokenIn   PRC-20 address of bridged token (e.g., pSOL)
     * @param tokenOut  Target PRC-20 address (e.g., pETH)
     * @param poolFee   Uniswap V3 pool fee tier (500 = 0.05%, 3000 = 0.3%)
     * @param amountIn  Amount of tokenIn to swap (must match bridged amount)
     * @param amountOutMin Minimum output (slippage protection)
     * @param recipient Address to receive swapped tokens (user's UEA)
     * @param deadline  Unix timestamp deadline
     */
    function bridgeAndSwap(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        // The gateway has already minted tokenIn to this contract
        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        require(balance >= amountIn, "INSUFFICIENT_BRIDGED_AMOUNT");

        // Approve FeeRouter if needed (one-time max approval for gas efficiency)
        if (IERC20(tokenIn).allowance(address(this), feeRouter) < amountIn) {
            IERC20(tokenIn).approve(feeRouter, MAX_UINT);
        }

        // Execute swap through FeeRouter (collects protocol fee)
        amountOut = IMoleSwapFeeRouter(feeRouter).swapExactInputSingle(
            tokenIn,
            tokenOut,
            poolFee,
            amountIn,
            amountOutMin,
            deadline,
            0 // sqrtPriceLimitX96 = 0 (no limit)
        );

        // Transfer output to recipient (FeeRouter sends to msg.sender which is this contract)
        // Actually FeeRouter sends directly to msg.sender, but let's handle both cases
        uint256 outBalance = IERC20(tokenOut).balanceOf(address(this));
        if (outBalance > 0) {
            IERC20(tokenOut).transfer(recipient, outBalance);
        }

        emit BridgeAndSwap(recipient, tokenIn, tokenOut, amountIn, amountOut);
    }

    /**
     * @notice Multi-hop bridge + swap (A → WPC → B, atomic)
     * @dev For routes without direct pools. Uses SwapRouter.exactInput for atomicity.
     *
     * @param tokenIn   PRC-20 address of bridged token
     * @param tokenOut  Target PRC-20 address
     * @param path      Encoded swap path: tokenIn + fee + WPC + fee + tokenOut
     * @param amountIn  Amount of tokenIn to swap
     * @param amountOutMin Minimum output
     * @param recipient Address to receive swapped tokens
     * @param deadline  Unix timestamp deadline
     */
    function bridgeAndSwapMultiHop(
        address tokenIn,
        address tokenOut,
        bytes calldata path,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        require(balance >= amountIn, "INSUFFICIENT_BRIDGED_AMOUNT");

        // Approve SwapRouter (multi-hop bypasses FeeRouter)
        if (IERC20(tokenIn).allowance(address(this), swapRouter) < amountIn) {
            IERC20(tokenIn).approve(swapRouter, MAX_UINT);
        }

        // Execute multi-hop swap
        amountOut = ISwapRouter(swapRouter).exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: recipient,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin
            })
        );

        // Count hops from path length: each hop = 20 bytes (addr) + 3 bytes (fee)
        // Path format: addr(20) + fee(3) + addr(20) + fee(3) + addr(20) = 2 hops
        uint8 hops = uint8((path.length - 20) / 23);

        emit BridgeAndSwapMultiHop(recipient, tokenIn, tokenOut, amountIn, amountOut, hops);
    }

    /**
     * @notice Bridge native (SOL/ETH) and swap to any token
     * @dev For native asset bridge-in. Gateway sends native value, we wrap + swap.
     */
    function bridgeNativeAndSwap(
        address tokenOut,
        uint24 poolFee,
        uint256 amountOutMin,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        require(msg.value > 0, "NO_NATIVE_VALUE");

        // Wrap native PC → WPC
        IWPC(wpc).deposit{value: msg.value}();

        uint256 amountIn = msg.value;

        // If tokenOut is WPC, just transfer (wrap only)
        if (tokenOut == wpc) {
            IERC20(wpc).transfer(recipient, amountIn);
            emit BridgeAndSwap(recipient, address(0), wpc, amountIn, amountIn);
            return amountIn;
        }

        // Approve and swap
        if (IERC20(wpc).allowance(address(this), feeRouter) < amountIn) {
            IERC20(wpc).approve(feeRouter, MAX_UINT);
        }

        amountOut = IMoleSwapFeeRouter(feeRouter).swapExactInputSingle(
            wpc,
            tokenOut,
            poolFee,
            amountIn,
            amountOutMin,
            deadline,
            0
        );

        // Transfer output if still here
        uint256 outBalance = IERC20(tokenOut).balanceOf(address(this));
        if (outBalance > 0) {
            IERC20(tokenOut).transfer(recipient, outBalance);
        }

        emit BridgeAndSwap(recipient, address(0), tokenOut, amountIn, amountOut);
    }

    /**
     * @notice Bridge and swap to native PC (unwrap at end)
     */
    function bridgeAndSwapToNative(
        address tokenIn,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMin,
        address payable recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        require(balance >= amountIn, "INSUFFICIENT_BRIDGED_AMOUNT");

        if (IERC20(tokenIn).allowance(address(this), feeRouter) < amountIn) {
            IERC20(tokenIn).approve(feeRouter, MAX_UINT);
        }

        // Swap to WPC
        uint256 wpcOut = IMoleSwapFeeRouter(feeRouter).swapExactInputSingle(
            tokenIn,
            wpc,
            poolFee,
            amountIn,
            amountOutMin,
            deadline,
            0
        );

        // Get WPC balance and unwrap
        uint256 wpcBalance = IWPC(wpc).balanceOf(address(this));
        if (wpcBalance > 0) {
            IWPC(wpc).withdraw(wpcBalance);
            amountOut = wpcBalance;
        }

        // Send native PC to recipient
        (bool sent, ) = recipient.call{value: address(this).balance}("");
        require(sent, "NATIVE_TRANSFER_FAILED");

        emit BridgeAndSwap(recipient, tokenIn, address(0), amountIn, amountOut);
    }

    // ═══ ADMIN ═══

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    function rescueNative() external onlyOwner {
        (bool sent, ) = payable(owner).call{value: address(this).balance}("");
        require(sent, "TRANSFER_FAILED");
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        owner = newOwner;
    }

    receive() external payable {}
}
