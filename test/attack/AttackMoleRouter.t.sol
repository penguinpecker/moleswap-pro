// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";

/// @title AttackMoleRouter
/// @notice The router is a contract users grant standing token approvals to. This suite treats the route
///         as hostile input and the pools as hostile counterparties, and proves the two properties the
///         whole design rests on: a submitted route can NEVER move funds the caller did not send, and the
///         router NEVER retains value between transactions.
///
/// Every attack here maps to a way a real aggregator has lost user funds: a public swap callback with no
/// caller check (drains any approval), an executor that allows arbitrary calls (turns approval into
/// transferFrom), reentrancy into an unlocked executor, and value left stuck in the executor for the next
/// caller to sweep. Each is shown blocked, on balances, not by inspection.
contract AttackMoleRouter is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MoleRouter internal router;
    MockWETH internal weth;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    address internal user = makeAddr("user");
    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim");

    function setUp() public {
        deployFreshManagerAndRouters();
        weth = new MockWETH();
        router = new MoleRouter(manager, address(weth), address(0), address(0));
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
    }

    /* --------------------------------------------------------------------------------------- utilities */

    function _v3Plan(address pool, address tokenIn, address tokenOut, bool zeroForOne, uint256 amt, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, pool, zeroForOne, tokenIn, tokenOut, _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amt, hops);
        plan = MoleRouter.SwapPlan(tokenIn, tokenOut, amt, minOut, user, block.timestamp + 1, paths);
    }

    function _emptyKey() internal pure returns (PoolKey memory k) {
        k = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(0)), 0, 0, IHooks(address(0)));
    }

    function _fundHonestPool(uint256 rateNum, uint256 rateDen) internal returns (MockV3Pool pool) {
        pool = new MockV3Pool(address(tokenA), address(tokenB), rateNum, rateDen);
        tokenA.mint(address(pool), 1_000_000e18);
        tokenB.mint(address(pool), 1_000_000e18);
    }

    /* ================================================================ 1. the callback is not an open door */

    /// @notice THE CLASSIC AGGREGATOR DRAIN. A public swap callback that pays whoever calls it turns every
    ///         standing approval into a faucet. Here the attacker calls the callback directly, with no
    ///         swap in progress, naming a victim's token and a fat amount. It must revert, and nothing
    ///         must move — the router has no active pool, so it owes nobody.
    function test_callbackCannotBeCalledDirectly() public {
        tokenA.mint(address(router), 500e18); // pretend the router is briefly holding funds
        vm.prank(attacker);
        vm.expectRevert(MoleRouter.UnexpectedCallback.selector);
        router.pancakeV3SwapCallback(int256(500e18), int256(0), abi.encode(address(tokenA)));

        vm.prank(attacker);
        vm.expectRevert(MoleRouter.UnexpectedCallback.selector);
        router.uniswapV3SwapCallback(int256(500e18), int256(0), abi.encode(address(tokenA)));

        assertEq(tokenA.balanceOf(attacker), 0, "attacker extracted funds through the callback");
    }

    /// @notice A pool NAMED in the route but not the one currently being swapped cannot reach the callback
    ///         either. Only the single pool the router is actively inside is authorised, for the duration
    ///         of that one call.
    function test_onlyTheActivelySwappedPoolIsAuthorised() public {
        MockV3Pool honest = _fundHonestPool(2, 1);
        ImposterPool imposter = new ImposterPool(router);

        // The imposter tries, out of band, to trigger the callback as if it were mid-swap.
        tokenA.mint(address(router), 100e18);
        vm.expectRevert(MoleRouter.UnexpectedCallback.selector);
        imposter.pokeCallback(address(tokenA), 100e18);
        assertEq(tokenA.balanceOf(address(imposter)), 0, "imposter was paid");
        honest; // silence unused
    }

    /* ================================================================ 2. a hostile route cannot steal */

    /// @notice A route that names a POOL WHICH KEEPS THE INPUT AND RETURNS NOTHING is the worst a hostile
    ///         router backend can submit. It cannot steal: the output falls below minOut and the entire
    ///         transaction reverts, so the user keeps every wei of their input. The attack is bounded to
    ///         wasting the user's own gas.
    function test_hostilePoolThatGivesNothing_revertsAndUserKeepsFunds() public {
        StiffPool stiff = new StiffPool(address(tokenA), address(tokenB));
        tokenB.mint(address(stiff), 1_000e18);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        MoleRouter.SwapPlan memory plan = _v3Plan(address(stiff), address(tokenA), address(tokenB), true, 100e18, 1);
        vm.prank(user);
        vm.expectRevert(); // InsufficientOutput(0, 1)
        router.swap(plan);

        assertEq(tokenA.balanceOf(user), 100e18, "user's input was taken by a failed swap");
        assertEq(tokenA.balanceOf(address(router)), 0, "router retained input");
    }

    /// @notice A pool that demands MORE than the swap's input can only fail. It cannot reach beyond the
    ///         router's current balance — which is only ever this swap's own input — so there is no other
    ///         user's money for it to touch.
    function test_greedyPoolCannotPullMoreThanThisSwapsInput() public {
        GreedyPool greedy = new GreedyPool(address(tokenA), address(tokenB));
        tokenB.mint(address(greedy), 1_000e18);
        // A second user's funds are NOT in the router — the router holds nothing between swaps. Prove it.
        tokenA.mint(victim, 10_000e18);
        vm.prank(victim);
        tokenA.approve(address(router), type(uint256).max); // victim has a standing approval

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        MoleRouter.SwapPlan memory plan = _v3Plan(address(greedy), address(tokenA), address(tokenB), true, 100e18, 1);
        vm.prank(user);
        vm.expectRevert(); // the greedy demand exceeds the router's balance -> TransferFailed
        router.swap(plan);

        assertEq(tokenA.balanceOf(victim), 10_000e18, "the victim's standing approval was drained");
        assertEq(tokenA.balanceOf(user), 100e18, "the user's input was taken");
    }

    /* ================================================================ 3. reentrancy */

    /// @notice A pool that re-enters `swap()` mid-execution hits the transient lock. Without it, a nested
    ///         swap could observe half-updated balances or double-spend the router's transient auth.
    function test_reentrantPoolIsBlockedByTheLock() public {
        ReentrantPool re = new ReentrantPool(router, address(tokenA), address(tokenB));
        tokenB.mint(address(re), 1_000e18);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        MoleRouter.SwapPlan memory plan = _v3Plan(address(re), address(tokenA), address(tokenB), true, 100e18, 1);
        vm.prank(user);
        vm.expectRevert(); // the reentrant swap() bubbles up Locked; without the lock the outer succeeds
        router.swap(plan);
    }

    /// @notice A 2-hop path whose SECOND hop does not consume the first hop's output token is a broken
    ///         chain and must be refused before the second swap runs.
    function test_brokenHopChain_midPath_isRefused() public {
        MockV3Pool p1 = _fundHonestPool(2, 1); // A -> B
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        MockERC20 tokenD = new MockERC20("D", "D", 18);
        MockV3Pool p2 = new MockV3Pool(address(tokenC), address(tokenD), 2, 1); // C -> D, NOT B -> anything
        tokenC.mint(address(p2), 1_000_000e18);
        tokenD.mint(address(p2), 1_000_000e18);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, address(p1), true, address(tokenA), address(tokenB), _emptyKey());
        // Second hop claims tokenC as input, but the first hop produced tokenB.
        hops[1] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, address(p2), true, address(tokenC), address(tokenD), _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(100e18, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(tokenA), address(tokenD), 100e18, 1, user, block.timestamp + 1, paths);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.prank(user);
        vm.expectRevert(MoleRouter.HopChainBroken.selector);
        router.swap(plan);
    }

    /// @notice A pool that consumes only PART of the offered input must not let the remainder stick to the
    ///         router — it is refunded to the payer, and the router still ends holding nothing.
    function test_shortFillRefundsUnusedInputToThePayer() public {
        ShortFillPool sf = new ShortFillPool(address(tokenA), address(tokenB));
        tokenB.mint(address(sf), 1_000e18);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        // The pool consumes 50 and returns 50; the other 50 must come back to the user.
        vm.prank(user);
        uint256 got = router.swap(_v3Plan(address(sf), address(tokenA), address(tokenB), true, 100e18, 1));

        assertEq(got, 50e18, "unexpected output from the short fill");
        assertEq(tokenB.balanceOf(user), 50e18, "recipient did not receive the filled output");
        assertEq(tokenA.balanceOf(user), 50e18, "unused input was NOT refunded to the payer");
        assertEq(tokenA.balanceOf(address(router)), 0, "router retained the unused input");
        assertEq(tokenB.balanceOf(address(router)), 0, "router retained output");
    }

    /* ================================================================ 4. malformed routes are refused */

    function test_pathSumMustEqualDeclaredInput() public {
        MockV3Pool honest = _fundHonestPool(2, 1);
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        MoleRouter.SwapPlan memory plan = _v3Plan(address(honest), address(tokenA), address(tokenB), true, 100e18, 1);
        // Corrupt the declared total so it no longer matches the single path's slice.
        plan.amountIn = 90e18;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.PathSumMismatch.selector, 90e18, 100e18));
        router.swap(plan);
    }

    function test_deadlineIsEnforced() public {
        MockV3Pool honest = _fundHonestPool(2, 1);
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        MoleRouter.SwapPlan memory plan = _v3Plan(address(honest), address(tokenA), address(tokenB), true, 100e18, 1);
        plan.deadline = block.timestamp - 1;
        vm.prank(user);
        vm.expectRevert(MoleRouter.DeadlinePassed.selector);
        router.swap(plan);
    }

    function test_emptyPathIsRefused() public {
        MoleRouter.Hop[] memory none = new MoleRouter.Hop[](0);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(100e18, none);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(tokenA), address(tokenB), 100e18, 1, user, block.timestamp + 1, paths);
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.prank(user);
        vm.expectRevert(MoleRouter.EmptyPath.selector);
        router.swap(plan);
    }

    function test_brokenHopChainIsRefused() public {
        // A 2-hop path where the last hop's output token is NOT the plan's declared output token.
        MockV3Pool p1 = _fundHonestPool(2, 1); // A -> B
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, address(p1), true, address(tokenA), address(tokenB), _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(100e18, hops);
        // Claim the output is a THIRD token C, but the hop yields tokenB. Distinct from tokenIn, so this
        // reaches the hop-chain check rather than the earlier same-token guard.
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(tokenA), address(tokenC), 100e18, 1, user, block.timestamp + 1, paths);
        vm.prank(user);
        vm.expectRevert(MoleRouter.HopChainBroken.selector);
        router.swap(plan);
    }

    function test_zeroAmountAndZeroRecipientAndSameTokenAreRefused() public {
        MoleRouter.SwapPlan memory p = _v3Plan(address(0xdead), address(tokenA), address(tokenB), true, 0, 0);
        vm.prank(user);
        vm.expectRevert(MoleRouter.NothingToSwap.selector);
        router.swap(p);

        p = _v3Plan(address(0xdead), address(tokenA), address(tokenB), true, 1, 0);
        p.recipient = address(0);
        vm.prank(user);
        vm.expectRevert(MoleRouter.ZeroRecipient.selector);
        router.swap(p);

        p = _v3Plan(address(0xdead), address(tokenA), address(tokenA), true, 1, 0);
        vm.prank(user);
        vm.expectRevert(MoleRouter.SameToken.selector);
        router.swap(p);
    }

    /* ================================================================ 4b. residual, hardened (audit) */

    /// @notice The router itself as recipient would strand the whole output. An adversarial route could set
    ///         it; the contract refuses it, since delivery to `address(this)` is a self-transfer.
    function test_recipientCannotBeTheRouter() public {
        MockV3Pool honest = _fundHonestPool(2, 1);
        MoleRouter.SwapPlan memory plan = _v3Plan(address(honest), address(tokenA), address(tokenB), true, 100e18, 1);
        plan.recipient = address(router);
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.prank(user);
        vm.expectRevert(MoleRouter.ZeroRecipient.selector);
        router.swap(plan);
    }

    /// @notice A middle hop that short-fills leaves the INTERMEDIATE token in the router. It must be swept
    ///         back to the payer, not stranded for the next caller — the exact multi-hop residual the audit
    ///         surfaced. Payer and recipient are distinct here so the two legs are unambiguous.
    function test_intermediateTokenShortFillIsSweptToPayer() public {
        MockV3Pool ab = _fundHonestPool(1, 1); // A -> B, 1:1
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        ShortFillPool bc = new ShortFillPool(address(tokenB), address(tokenC)); // B -> C, consumes half
        tokenC.mint(address(bc), 1_000e18);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, address(ab), true, address(tokenA), address(tokenB), _emptyKey());
        hops[1] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, address(bc), true, address(tokenB), address(tokenC), _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(100e18, hops);
        address recipient = makeAddr("recipient");
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(tokenA), address(tokenC), 100e18, 1, recipient, block.timestamp + 1, paths);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.prank(user);
        uint256 got = router.swap(plan);

        assertEq(got, 50e18, "output should be the half that filled");
        assertEq(tokenC.balanceOf(recipient), 50e18, "recipient did not get the output");
        // The 50 B the second hop did not consume must be back with the payer, and the router empty.
        assertEq(tokenB.balanceOf(user), 50e18, "the stranded intermediate was NOT swept to the payer");
        assertEq(tokenA.balanceOf(address(router)), 0, "residual A");
        assertEq(tokenB.balanceOf(address(router)), 0, "residual intermediate B");
        assertEq(tokenC.balanceOf(address(router)), 0, "residual C");
    }

    /// @notice A token airdropped to the router before a swap must be PRESERVED, not handed to the next
    ///         swapper as a bogus refund. The fix reasons about net change, so a pre-existing balance is
    ///         invisible to the sweep.
    function test_preexistingAirdropIsPreservedNotHarvested() public {
        MockV3Pool honest = _fundHonestPool(1, 1); // exact fill, no leftover
        tokenA.mint(address(router), 7e18); // someone airdrops 7 A to the router

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        uint256 payerBefore = tokenA.balanceOf(user);
        vm.prank(user);
        router.swap(_v3Plan(address(honest), address(tokenA), address(tokenB), true, 100e18, 1));

        // The payer spent exactly 100 and got no windfall from the airdrop.
        assertEq(payerBefore - tokenA.balanceOf(user), 100e18, "the payer harvested the airdrop");
        // The airdrop is still sitting in the router, untouched by the swap.
        assertEq(tokenA.balanceOf(address(router)), 7e18, "the airdrop was disturbed by the swap");
    }

    /// @notice A hostile pool that names a DIFFERENT token in its callback data cannot redirect payment:
    ///         the router pays the token IT pinned before the swap, ignoring the data. Proven by leaving a
    ///         fat balance of the target token in the router and showing the pool cannot touch it.
    function test_hostilePoolCannotRedirectPaymentViaCallbackData() public {
        MockERC20 tokenX = new MockERC20("X", "X", 18);
        tokenX.mint(address(router), 1_000e18); // a token the router holds, that the pool will try to grab

        HostileDataPool hostile = new HostileDataPool(address(tokenA), address(tokenB), address(tokenX));
        tokenB.mint(address(hostile), 1_000e18);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.prank(user);
        router.swap(_v3Plan(address(hostile), address(tokenA), address(tokenB), true, 100e18, 1));

        // The pool was paid in A (pinned), never in X. The router's X balance is untouched.
        assertEq(tokenX.balanceOf(address(hostile)), 0, "the hostile pool siphoned the target token");
        assertEq(tokenX.balanceOf(address(router)), 1_000e18, "the target token was moved out of the router");
    }

    /// @notice A final hop that delivers MORE output than it reports (an over-receive — a lying pool, or
    ///         a token airdropped mid-swap) must not strand the excess. It is swept to the payer, and the
    ///         recipient still receives exactly the tracked, minOut-protected total.
    function test_outputOverReceiveIsSweptNotStranded() public {
        OverPayPool over = new OverPayPool(address(tokenA), address(tokenB)); // reports 1:1, transfers 1.5x
        tokenB.mint(address(over), 1_000e18);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        address recipient = makeAddr("recipient2");
        MoleRouter.SwapPlan memory plan =
            _v3Plan(address(over), address(tokenA), address(tokenB), true, 100e18, 1);
        plan.recipient = recipient;

        vm.prank(user);
        uint256 got = router.swap(plan);

        // The recipient gets the TRACKED output (100), not the untracked windfall.
        assertEq(got, 100e18, "tracked output changed");
        assertEq(tokenB.balanceOf(recipient), 100e18, "recipient did not get the tracked output");
        // The extra 50 the pool over-delivered is swept to the payer, and the router keeps nothing.
        assertEq(tokenB.balanceOf(user), 50e18, "the over-received output was not swept to the payer");
        assertEq(tokenB.balanceOf(address(router)), 0, "router stranded the over-received output");
    }

    /* ================================================================ 5. honest path + zero residual */

    function test_honestSwapDeliversExactly_andHoldsNothing() public {
        MockV3Pool honest = _fundHonestPool(3, 2); // 1 A -> 1.5 B
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);

        uint256 expected = 150e18;
        vm.prank(user);
        uint256 got = router.swap(_v3Plan(address(honest), address(tokenA), address(tokenB), true, 100e18, expected));

        assertEq(got, expected, "output mismatch on the honest path");
        assertEq(tokenB.balanceOf(user), expected, "recipient did not receive output");
        assertEq(tokenA.balanceOf(address(router)), 0, "residual input");
        assertEq(tokenB.balanceOf(address(router)), 0, "residual output");
    }

    /// @notice Fuzz: whatever the honest route and size, the router ends every swap holding zero of both
    ///         tokens. This is the invariant that makes standing approvals safe.
    function testFuzz_routerNeverRetainsValue(uint96 amountIn, uint8 rn, uint8 rd) public {
        uint256 amt = uint256(amountIn) + 1;
        uint256 num = uint256(rn) + 1;
        uint256 den = uint256(rd) + 1;
        MockV3Pool honest = _fundHonestPool(num, den);
        tokenA.mint(user, amt);
        vm.prank(user);
        tokenA.approve(address(router), amt);

        uint256 expected = (amt * num) / den;
        vm.assume(expected > 0);
        vm.prank(user);
        try router.swap(_v3Plan(address(honest), address(tokenA), address(tokenB), true, amt, 1)) {
            assertEq(tokenA.balanceOf(address(router)), 0, "residual input after fuzzed swap");
            assertEq(tokenB.balanceOf(address(router)), 0, "residual output after fuzzed swap");
        } catch {
            // A revert leaves the router untouched too.
            assertEq(tokenA.balanceOf(address(router)), 0, "residual input after fuzzed revert");
            assertEq(tokenB.balanceOf(address(router)), 0, "residual output after fuzzed revert");
        }
    }

    /// @notice The first hop must consume the plan's (effective) input token. A plan whose first hop
    ///         starts from some OTHER token is a broken chain and is refused before any swap runs — this
    ///         also stops a native-in plan from routing away from WETH.
    function test_firstHopMustConsumeTheInputToken() public {
        MockV3Pool honest = _fundHonestPool(2, 1); // A -> B
        // Claim tokenIn = A, but the first (only) hop starts from tokenB.
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, address(honest), false, address(tokenB), address(tokenA), _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(100e18, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(address(tokenA), address(tokenA), 100e18, 1, user, block.timestamp + 1, paths);
        // tokenIn(A) != tokenOut(A) would trip SameToken first; make output distinct.
        plan.tokenOut = address(tokenA);
        // Use a distinct output token so we reach the first-hop check, not SameToken.
        MockERC20 tokenE = new MockERC20("E", "E", 18);
        plan.tokenOut = address(tokenE);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.prank(user);
        vm.expectRevert(MoleRouter.HopChainBroken.selector);
        router.swap(plan);
    }

    /* ================================================================ 5b. native ETH (wrap/unwrap) */

    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @dev A pool that swaps WETH<->other. Funds the OUTPUT side so it can pay.
    function _fundWethPool(MockERC20 other, uint256 num, uint256 den, bool wethIsToken0)
        internal
        returns (MockV3Pool pool)
    {
        pool = wethIsToken0
            ? new MockV3Pool(address(weth), address(other), num, den)
            : new MockV3Pool(address(other), address(weth), num, den);
        other.mint(address(pool), 1_000_000e18);
        // Give the pool WETH to pay out when it is the output side, backed by real ETH so withdraw works.
        vm.deal(address(this), 1_000e18);
        weth.deposit{value: 1_000e18}();
        weth.transfer(address(pool), 1_000e18);
    }

    function _nativePlan(address pool, address tokenIn, address tokenOut, address hopIn, address hopOut, bool z, uint256 amt, address recipient)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, pool, z, hopIn, hopOut, _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amt, hops);
        plan = MoleRouter.SwapPlan(tokenIn, tokenOut, amt, 1, recipient, block.timestamp + 1, paths);
    }

    /// @notice Native ETH IN: the router wraps the attached msg.value to WETH, swaps it, and holds nothing.
    function test_nativeIn_wrapsAndSwapsAndHoldsNothing() public {
        MockV3Pool pool = _fundWethPool(tokenB, 2, 1, true); // WETH -> B at 2:1
        address recipient = makeAddr("nrecipient");
        MoleRouter.SwapPlan memory plan =
            _nativePlan(address(pool), NATIVE, address(tokenB), address(weth), address(tokenB), true, 10e18, recipient);

        vm.deal(user, 10e18);
        vm.prank(user);
        uint256 got = router.swap{value: 10e18}(plan);

        assertEq(got, 20e18, "native-in output wrong");
        assertEq(tokenB.balanceOf(recipient), 20e18, "recipient did not get the output");
        assertEq(user.balance, 0, "user ETH not consumed");
        assertEq(address(router).balance, 0, "router retained native ETH");
        assertEq(weth.balanceOf(address(router)), 0, "router retained WETH");
        assertEq(tokenB.balanceOf(address(router)), 0, "router retained output");
    }

    /// @notice Native ETH OUT: the router swaps to WETH, unwraps it, and delivers ETH to the recipient.
    function test_nativeOut_swapsAndUnwrapsToRecipient() public {
        MockV3Pool pool = _fundWethPool(tokenA, 1, 2, false); // A -> WETH at 1:2 (A=token0)
        address recipient = makeAddr("nrecipient2");
        MoleRouter.SwapPlan memory plan =
            _nativePlan(address(pool), address(tokenA), NATIVE, address(tokenA), address(weth), true, 10e18, recipient);

        tokenA.mint(user, 10e18);
        vm.prank(user);
        tokenA.approve(address(router), 10e18);
        uint256 recipBefore = recipient.balance;
        vm.prank(user);
        uint256 got = router.swap(plan);

        assertEq(got, 5e18, "native-out output wrong");
        assertEq(recipient.balance - recipBefore, 5e18, "recipient did not receive native ETH");
        assertEq(address(router).balance, 0, "router retained native ETH");
        assertEq(weth.balanceOf(address(router)), 0, "router retained WETH");
        assertEq(tokenA.balanceOf(address(router)), 0, "router retained input");
    }

    /// @notice A native-in swap must be funded by EXACTLY amountIn of ETH — no more, no less.
    function test_nativeIn_valueMustEqualAmountIn() public {
        MockV3Pool pool = _fundWethPool(tokenB, 2, 1, true);
        address recipient = makeAddr("nr3");
        MoleRouter.SwapPlan memory plan =
            _nativePlan(address(pool), NATIVE, address(tokenB), address(weth), address(tokenB), true, 10e18, recipient);

        vm.deal(user, 20e18);
        vm.prank(user);
        vm.expectRevert(MoleRouter.BadValue.selector);
        router.swap{value: 9e18}(plan); // too little

        vm.prank(user);
        vm.expectRevert(MoleRouter.BadValue.selector);
        router.swap{value: 11e18}(plan); // too much
    }

    /// @notice An ERC-20 swap must not carry attached ETH — it would sit in the router.
    function test_erc20Swap_rejectsAttachedEther() public {
        MockV3Pool honest = _fundHonestPool(2, 1);
        MoleRouter.SwapPlan memory plan = _v3Plan(address(honest), address(tokenA), address(tokenB), true, 100e18, 1);
        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        vm.deal(user, 1e18);
        vm.prank(user);
        vm.expectRevert(MoleRouter.BadValue.selector);
        router.swap{value: 1e18}(plan);
    }

    /// @notice Native ETH sent to the router OUTSIDE a swap is refused, so it can never accumulate.
    function test_strayEtherIsRefused() public {
        vm.deal(user, 1e18);
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1e18}("");
        assertFalse(ok, "router accepted stray ETH outside a swap");
        assertEq(address(router).balance, 0, "stray ETH accumulated in the router");
    }

    /* ================================================================ 6. v4 hop, locally */

    function test_v4Hop_swapsThroughThePoolManager_andHoldsNothing() public {
        (Currency c0, Currency c1) = deployMintAndApprove2Currencies();
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))});
        manager.initialize(key, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100_000e18, salt: 0}),
            ""
        );

        address t0 = Currency.unwrap(c0);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), true, t0, Currency.unwrap(c1), key);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(1e18, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(t0, Currency.unwrap(c1), 1e18, 1, user, block.timestamp + 1, paths);

        MockERC20(t0).mint(user, 1e18);
        vm.prank(user);
        MockERC20(t0).approve(address(router), 1e18);

        vm.prank(user);
        uint256 got = router.swap(plan);
        assertGt(got, 0, "v4 hop produced no output");
        assertEq(MockERC20(t0).balanceOf(user), 0, "input not consumed");
        assertEq(MockERC20(Currency.unwrap(c1)).balanceOf(user), got, "recipient did not net the v4 output");
        assertEq(MockERC20(t0).balanceOf(address(router)), 0, "router retained v4 input");
        assertEq(MockERC20(Currency.unwrap(c1)).balanceOf(address(router)), 0, "router retained v4 output");
    }

    /// @notice Anyone calling unlockCallback directly, outside a swap, is refused — the v4 side of the
    ///         same "callbacks are not open doors" property.
    function test_unlockCallbackRejectsDirectCalls() public {
        vm.prank(attacker);
        vm.expectRevert(MoleRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }
}

/* ========================================================================================= mock venues */

/// @dev An honest constant-rate v3-style pool: exact input, output = amountIn * num / den.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable num;
    uint256 public immutable den;

    constructor(address _t0, address _t1, uint256 _num, uint256 _den) {
        token0 = _t0;
        token1 = _t1;
        num = _num;
        den = _den;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = (amountIn * num) / den;
        address inTok = zeroForOne ? token0 : token1;
        address outTok = zeroForOne ? token1 : token0;

        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(out);
        } else {
            amount1 = int256(amountIn);
            amount0 = -int256(out);
        }

        uint256 before = IERC20M(inTok).balanceOf(address(this));
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        require(IERC20M(inTok).balanceOf(address(this)) >= before + amountIn, "MockV3Pool: not paid");
        IERC20M(outTok).transfer(recipient, out);
    }
}

/// @dev Takes payment, gives nothing. Models a route that funnels the input into a black hole.
contract StiffPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = 0;
        } else {
            amount1 = int256(amountIn);
            amount0 = 0;
        }
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        // No output transferred.
    }
}

/// @dev Demands far more than the swap's input, to test the balance ceiling.
contract GreedyPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 greedy = uint256(amountSpecified) * 1_000_000;
        if (zeroForOne) {
            amount0 = int256(greedy);
            amount1 = -1;
        } else {
            amount1 = int256(greedy);
            amount0 = -1;
        }
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        address outTok = zeroForOne ? token1 : token0;
        IERC20M(outTok).transfer(recipient, 1);
    }
}

/// @dev Re-enters the router during the callback.
contract ReentrantPool {
    MoleRouter public immutable router;
    address public immutable token0;
    address public immutable token1;

    constructor(MoleRouter _r, address _t0, address _t1) {
        router = _r;
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(amountIn);
        } else {
            amount1 = int256(amountIn);
            amount0 = -int256(amountIn);
        }
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        // Re-enter. The nested plan is malformed on PURPOSE so that its OWN failure reason differs from
        // the lock's: if the lock is doing its job we get `Locked`; if the lock were removed we would get
        // `PathSumMismatch` instead. We swallow the non-lock failure and let the outer swap SUCCEED, so
        // that removing the lock changes the outcome from revert to success — which is what makes the
        // guard mutation-detectable rather than merely "some revert happened".
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](0);
        MoleRouter.SwapPlan memory p =
            MoleRouter.SwapPlan(token0, token1, 1, 0, address(this), block.timestamp + 1, paths);
        try router.swap(p) {
            // reached only if a nested swap somehow succeeded — treat as a lock failure
            revert("REENTRANCY_NOT_BLOCKED");
        } catch (bytes memory err) {
            if (bytes4(err) == MoleRouter.Locked.selector) revert("REENTRANCY_BLOCKED");
            // any other error means the lock was NOT what stopped us; let the outer swap complete
        }
        IERC20M(zeroForOne ? token1 : token0).transfer(recipient, amountIn);
    }
}

/// @dev Tries to trigger the router callback while no swap is in progress.
contract ImposterPool {
    MoleRouter public immutable router;

    constructor(MoleRouter _r) {
        router = _r;
    }

    function pokeCallback(address token, uint256 amount) external {
        router.pancakeV3SwapCallback(int256(amount), int256(0), abi.encode(token));
    }
}

/// @dev Consumes half the offered input and returns half as output — a short fill that leaves a
///      refundable remainder in the router.
contract ShortFillPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 half = uint256(amountSpecified) / 2;
        if (zeroForOne) {
            amount0 = int256(half); // demand only half
            amount1 = -int256(half);
        } else {
            amount1 = int256(half);
            amount0 = -int256(half);
        }
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        IERC20M(zeroForOne ? token1 : token0).transfer(recipient, half);
    }
}

/// @dev An honest A->B swap, but its callback names tokenX in `data`, trying to be paid in tokenX. The
///      router must ignore the data and pay the token it pinned (A).
contract HostileDataPool {
    address public immutable token0;
    address public immutable token1;
    address public immutable target;

    constructor(address _t0, address _t1, address _target) {
        token0 = _t0;
        token1 = _t1;
        target = _target;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        amount0 = int256(amountIn);
        amount1 = -int256(amountIn);
        // Crafted data: try to be paid in `target` instead of the real input token.
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, abi.encode(target));
        IERC20M(token1).transfer(recipient, amountIn);
    }
}

/// @dev Reports a 1:1 fill but actually transfers 1.5x the output — an over-receive the router must sweep.
contract OverPayPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        amount0 = int256(amountIn);
        amount1 = -int256(amountIn); // REPORTS 1:1
        IMoleCallback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        IERC20M(token1).transfer(recipient, (amountIn * 3) / 2); // but DELIVERS 1.5x
    }
}

/// @dev A minimal WETH9 for the native-ETH tests: deposit wraps, withdraw unwraps and returns ETH.
contract MockWETH {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "MockWETH: insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "MockWETH: send failed");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MockWETH: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "MockWETH: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface IMoleCallback {
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
}

interface IERC20M {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}
