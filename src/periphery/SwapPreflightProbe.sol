// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";

/// @title SwapPreflightProbe
/// @notice Runs a swap exactly as the swapper's wallet would, inside ONE `eth_call`, and reports what the
///         swapper would send and what the recipient would receive. It is NEVER DEPLOYED: its runtime code
///         is injected over the SWAPPER'S OWN ADDRESS with an `eth_call` state override, so `address(this)`
///         IS the swapper — the router sees the real `msg.sender`, `transferFrom` pulls from the real balance
///         against the real allowance, and a native-ETH swap is funded by the real ETH balance. No key is
///         touched and nothing is broadcast: a high-fidelity executability test, not a mined transaction.
///
/// WHY NOT JUST `eth_call` THE ROUTER. A plain call returns the router's `amountOut`, which is what the router
/// PUSHED — not what the recipient KEPT. A fee-on-transfer output token, a recipient the token refuses, or
/// injected calldata that names a different recipient all pass a plain call and only show up as a balance
/// diff. Measuring balances before and after from inside the same EVM frame is what makes this a pre-flight of
/// the user's actual experience. It also lets the approve step be simulated: the real flow sends `approve`
/// first and `swap` second, so the probe approves (as the swapper) before it swaps, exactly as lib/chain/amm.ts
/// does — only when the standing allowance is short, and for exactly `amountIn`.
///
/// WHAT IT DOES NOT PROVE. It is a pre-flight. State moves between simulation and inclusion, and a state
/// override can only simulate what the override says. Its numbers are never to be presented as guaranteed.
///
/// The frontend carries this contract's runtime code and the `preflight` signature in
/// frontend/lib/aggregator/preflightProbe.json; test/SwapPreflightProbe.t.sol pins both against this source so
/// the injected bytes can never drift from the Solidity that documents them.
contract SwapPreflightProbe {
    /// @dev Mirrors MoleRouter.NATIVE — the plan's tokenIn/tokenOut sentinel for native ETH.
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @dev The probe wears the swapper's address, and the swapper is (almost always) an EOA: an EOA accepts
    ///      ETH and answers any call with no data. The probe must do the same or the simulation lies —
    ///      without `receive`, the router's native-ETH delivery back to the swapper reverted inside the probe
    ///      and every ETH-out swap pre-flighted as a failure (found by test_nativeOut_receivedIsEth). The
    ///      fallback keeps token callbacks (ERC-1363/777-style `on…Received`) from reverting where an EOA
    ///      would not. Neither is reachable from the real transaction: the probe never exists on-chain.
    receive() external payable {}

    fallback() external payable {}

    /// @notice Where the simulated flow stopped. Carried as uint8 in `Result.stage`.
    enum Stage {
        /// @dev The router call returned; `sent`, `received` and `amountOut` are real.
        Ok,
        /// @dev The swapper does not hold `amountIn` of tokenIn (ETH for a native swap). Nothing was tried.
        InsufficientBalance,
        /// @dev The approve the real flow would send reverted; `revertData` is the token's own reason.
        ApproveFailed,
        /// @dev The router call reverted; `revertData` is the router's reason, decoded off-chain.
        SwapFailed
    }

    struct Result {
        uint8 stage;
        bytes revertData;
        /// @dev The router's return value — what it pushed — when stage == Ok.
        uint256 amountOut;
        /// @dev Swapper's tokenIn balance, before minus after (ETH for native).
        uint256 sent;
        /// @dev Recipient's tokenOut balance, after minus before (ETH for native).
        uint256 received;
        /// @dev Swapper's tokenIn balance before anything ran.
        uint256 balanceBefore;
        /// @dev Swapper→router allowance before the approve step (0 for native).
        uint256 allowanceBefore;
    }

    /// @param router        The executor the real transaction will call.
    /// @param swapCalldata  The EXACT calldata the transaction builder produced — forwarded verbatim.
    /// @param value         The ETH the real transaction attaches (amountIn for native-in, else 0).
    /// @param tokenIn       The plan's tokenIn (NATIVE sentinel or ERC-20).
    /// @param tokenOut      The plan's tokenOut (NATIVE sentinel or ERC-20).
    /// @param recipient     The plan's recipient — where `received` is measured.
    /// @param amountIn      The plan's amountIn — the balance check and the exact approve amount.
    function preflight(
        address router,
        bytes calldata swapCalldata,
        uint256 value,
        address tokenIn,
        address tokenOut,
        address recipient,
        uint256 amountIn
    ) external returns (Result memory r) {
        r.balanceBefore = _balance(tokenIn, address(this));
        if (r.balanceBefore < amountIn) {
            r.stage = uint8(Stage.InsufficientBalance);
            return r;
        }
        if (tokenIn != NATIVE) {
            r.allowanceBefore = IERC20Minimal(tokenIn).allowance(address(this), router);
            if (r.allowanceBefore < amountIn) {
                (bool aok, bytes memory aret) =
                    tokenIn.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, router, amountIn));
                if (!aok || (aret.length != 0 && !abi.decode(aret, (bool)))) {
                    r.stage = uint8(Stage.ApproveFailed);
                    r.revertData = aret;
                    return r;
                }
            }
        }
        uint256 outBefore = _balance(tokenOut, recipient);
        (bool ok, bytes memory ret) = router.call{value: value}(swapCalldata);
        if (!ok) {
            // The failed call's state is rolled back by the EVM; the probe itself returns normally so the
            // reason travels back as data rather than as an opaque eth_call failure.
            r.stage = uint8(Stage.SwapFailed);
            r.revertData = ret;
            return r;
        }
        r.amountOut = ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
        uint256 inAfter = _balance(tokenIn, address(this));
        uint256 outAfter = _balance(tokenOut, recipient);
        r.sent = r.balanceBefore > inAfter ? r.balanceBefore - inAfter : 0;
        r.received = outAfter > outBefore ? outAfter - outBefore : 0;
    }

    function _balance(address token, address who) internal view returns (uint256) {
        if (token == NATIVE) return who.balance;
        return IERC20Minimal(token).balanceOf(who);
    }
}
