// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleOrders} from "../../src/MoleOrders.sol";
import {OrdersWorld} from "../helpers/OrdersWorld.sol";

/// @notice A router stand-in that reproduces exactly the behaviours MoleRouter's zero-residual contract
///         permits, and lets a test dial each one independently:
///           - it returns unrouted INPUT to the payer (`refundIn`), which is `_sweep` doing its job;
///           - it returns a touched non-input token to the payer (`strandToken`/`strandAmount`), which is
///             `_sweep` doing its job on an intermediate or an over-delivered output;
///           - it can pull MORE than the plan's input (`overPull`), which the real router cannot but a
///             hostile token's allowance handling could permit.
///         MoleOrders is not upgradeable and its router is immutable, so the only way to prove the book
///         behaves correctly against a router that does these things is to hand it one that does.
contract StubRouter {
    IPoolManager public immutable poolManager;

    uint256 public refundIn;
    uint256 public overPull;
    address public strandToken;
    uint256 public strandAmount;

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    function configure(uint256 _refundIn, uint256 _overPull, address _strandToken, uint256 _strandAmount) external {
        refundIn = _refundIn;
        overPull = _overPull;
        strandToken = _strandToken;
        strandAmount = _strandAmount;
    }

    function swap(MoleRouter.SwapPlan calldata plan) external payable returns (uint256) {
        IERC20Minimal(plan.tokenIn).transferFrom(msg.sender, address(this), plan.amountIn + overPull);
        if (refundIn != 0) IERC20Minimal(plan.tokenIn).transfer(msg.sender, refundIn);
        if (strandAmount != 0) IERC20Minimal(strandToken).transfer(msg.sender, strandAmount);
        IERC20Minimal(plan.tokenOut).transfer(plan.recipient, plan.minAmountOut);
        return plan.minAmountOut;
    }
}

/// @notice An ERC-20 that grants an UNBOUNDED allowance no matter what it is asked for. Exactly the kind
///         of non-standard token an approval target must not assume away: MoleOrders sets an allowance of
///         precisely one leg, and this token silently turns it into infinity.
contract LooseToken {
    string public name = "LOOSE";
    string public symbol = "LOOSE";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256) external returns (bool) {
        allowance[msg.sender][spender] = type(uint256).max;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// F-02 mechanism E — the tokens that were burned rather than returned, plus the two accounting edges the
/// residual rewrite introduces.
///
/// MoleRouter's `_sweep` returns the increase of EVERY token it touched to the payer. MoleOrders' old
/// assertion inspected only `tokenIn`, and the contract had no outbound transfer of any kind — no sweep,
/// no rescue, no owner withdrawal — so an intermediate token short-filled by a middle hop, or an
/// over-delivered output token, landed in the book and stayed there forever. Every test here measures
/// where the tokens ended up.
contract AttackMoleOrdersStranded is OrdersWorld {
    StubRouter internal stub;
    MoleOrders internal stubBook;
    MockERC20 internal tokenC; // an intermediate, named by the route but never the order's own token
    LooseToken internal loose;
    PoolKey internal loosePool;

    uint256 internal constant LEG = 10e18;

    function setUp() public {
        _buildWorld(address(0));

        tokenC = new MockERC20("C", "C", 18);
        loose = new LooseToken();

        stub = new StubRouter(manager);
        stubBook = new MoleOrders(MoleRouter(payable(address(stub))), admin, keeper);

        // The stub needs stock of everything it hands out.
        tokenB.mint(address(stub), 1_000e18);
        tokenC.mint(address(stub), 1_000e18);
        tokenA.mint(address(stub), 1_000e18);
        loose.mint(owner, 1_000e18);

        vm.startPrank(owner);
        tokenA.approve(address(stubBook), type(uint256).max);
        loose.approve(address(stubBook), type(uint256).max);
        vm.stopPrank();

        // A live hooked pool for the LooseToken pair, so an order over it can carry a real price bound.
        // No liquidity: the stub is the venue here; the pool exists only to be an oracle.
        (Currency c0, Currency c1) = address(loose) < address(tokenB)
            ? (Currency.wrap(address(loose)), Currency.wrap(address(tokenB)))
            : (Currency.wrap(address(tokenB)), Currency.wrap(address(loose)));
        loosePool = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(loosePool, SQRT_PRICE_1_1);

        // Give the new pool a full window of history so `consult` can answer it.
        _advance(TWAP_WINDOW + 100);
    }

    function _stubOrder(address tokenIn, PoolKey memory refPool) internal returns (uint256 id) {
        vm.prank(owner);
        id = stubBook.createOrder(
            tokenIn, address(tokenB), LEG, LEG * 5, 1, 0, refPool, TWAP_WINDOW, SLIP_BPS
        );
    }

    /// @dev A route that names an intermediate: tokenIn → tokenC → tokenB. The hops are never executed
    ///      (the stub is the venue), but they are what `_sideTokens` reads to know what may come back.
    function _twoHopPlan(address tokenIn, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory)
    {
        PoolKey memory empty = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0)),
            fee: 0,
            tickSpacing: 0,
            hooks: IHooks(address(0))
        });
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.PancakeV3,
            pool: address(1),
            zeroForOne: true,
            tokenIn: tokenIn,
            tokenOut: address(tokenC),
            key: empty
        });
        hops[1] = MoleRouter.Hop({
            venue: MoleRouter.Venue.PancakeV3,
            pool: address(2),
            zeroForOne: true,
            tokenIn: address(tokenC),
            tokenOut: address(tokenB),
            key: empty
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});
        return MoleRouter.SwapPlan({
            tokenIn: tokenIn,
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: owner,
            deadline: block.timestamp + 60,
            paths: paths
        });
    }

    /* ───────────────────── MECHANISM E — nothing the route touches may be burned ─────────────────── */

    function test_strandedIntermediateTokenIsForwardedToTheOwner() public {
        uint256 id = _stubOrder(address(tokenA), oraclePool);
        (uint256 legIn, uint256 floorOut) = stubBook.currentLeg(id);
        stub.configure(0, 0, address(tokenC), 7e18); // a middle hop short-filled; the router swept it back

        uint256 ownerC0 = tokenC.balanceOf(owner);
        MoleRouter.SwapPlan memory p = _twoHopPlan(address(tokenA), legIn, floorOut);
        vm.prank(keeper);
        stubBook.fillLeg(id, p);

        assertEq(tokenC.balanceOf(owner) - ownerC0, 7e18, "the intermediate reached the owner");
        assertEq(tokenC.balanceOf(address(stubBook)), 0, "and none of it was burned in the book");
    }

    function test_overDeliveredOutputTokenIsForwardedToTheOwner() public {
        uint256 id = _stubOrder(address(tokenA), oraclePool);
        (uint256 legIn, uint256 floorOut) = stubBook.currentLeg(id);
        stub.configure(0, 0, address(tokenB), 3e18);

        uint256 ownerB0 = tokenB.balanceOf(owner);
        MoleRouter.SwapPlan memory p = _twoHopPlan(address(tokenA), legIn, floorOut);
        vm.prank(keeper);
        uint256 out = stubBook.fillLeg(id, p);

        assertEq(tokenB.balanceOf(owner) - ownerB0, out + 3e18, "the owner got the delivery AND the excess");
        assertEq(tokenB.balanceOf(address(stubBook)), 0, "nothing stranded");
    }

    /// @notice The sweep is bounded by a PRE-SWAP snapshot, so it can only return what this fill produced.
    ///         Without that baseline the mechanism would become a way for any order to harvest a balance
    ///         that a different owner's fill left behind.
    function test_aBalanceAlreadySittingInTheBookIsNotHarvestedByTheNextFill() public {
        tokenC.mint(address(stubBook), 5e18); // someone else's leftovers, from before this fix shipped

        uint256 id = _stubOrder(address(tokenA), oraclePool);
        (uint256 legIn, uint256 floorOut) = stubBook.currentLeg(id);
        stub.configure(0, 0, address(0), 0); // this fill strands nothing of its own

        uint256 ownerC0 = tokenC.balanceOf(owner);
        MoleRouter.SwapPlan memory p = _twoHopPlan(address(tokenA), legIn, floorOut);
        vm.prank(keeper);
        stubBook.fillLeg(id, p);

        assertEq(tokenC.balanceOf(owner), ownerC0, "this order took none of it");
        assertEq(tokenC.balanceOf(address(stubBook)), 5e18, "the pre-existing balance is untouched");
    }

    /* ─────────────────────────── the two accounting edges of the residual fix ────────────────────── */

    function test_aRouteThatHandsBackMoreThanTheLegChargesTheOwnerNothing() public {
        uint256 id = _stubOrder(address(tokenA), oraclePool);
        (uint256 legIn, uint256 floorOut) = stubBook.currentLeg(id);
        // A route whose intermediate hop produces the INPUT token can legitimately return more than the
        // leg. Charging `legIn - back` unguarded would underflow; the owner is charged nothing instead.
        stub.configure(legIn + 3, 0, address(0), 0);

        uint256 ownerA0 = tokenA.balanceOf(owner);
        MoleRouter.SwapPlan memory p = _twoHopPlan(address(tokenA), legIn, floorOut);
        vm.prank(keeper);
        stubBook.fillLeg(id, p);

        assertEq(tokenA.balanceOf(owner), ownerA0 + 3, "the owner ended up with MORE input than they paid");
        (,,,,, uint256 spent,,,,) = stubBook.orders(id);
        assertEq(spent, 0, "and was charged nothing for a leg that consumed nothing");
        assertEq(tokenA.balanceOf(address(stubBook)), 0, "nothing kept back");
    }

    function test_aFillThatLeavesTheBookPoorerThanItStartedIsRefused() public {
        // The book sets an allowance of exactly one leg. This token turns that into infinity, so a router
        // can take more than it was given — which would come out of a balance the book was holding for
        // somebody else. Fail closed.
        loose.mint(address(stubBook), 5); // a pre-existing dust balance the over-pull would eat

        uint256 id = _stubOrder(address(loose), loosePool);
        (uint256 legIn, uint256 floorOut) = stubBook.currentLeg(id);
        stub.configure(0, 1, address(0), 0); // pull one wei more than the leg

        MoleRouter.SwapPlan memory p = _twoHopPlan(address(loose), legIn, floorOut);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.Residual.selector);
        stubBook.fillLeg(id, p);

        assertEq(loose.balanceOf(address(stubBook)), 5, "the book's own balance survived");
        (,,,,, uint256 spent,,,,) = stubBook.orders(id);
        assertEq(spent, 0, "and nothing was charged");
    }

    /// @notice The control for the test above: the identical route with no over-pull settles cleanly, so
    ///         the refusal is caused by the over-pull and not by the token being unusual.
    function test_theSameLooseTokenFillSucceedsWhenTheRouterTakesOnlyItsLeg() public {
        loose.mint(address(stubBook), 5);

        uint256 id = _stubOrder(address(loose), loosePool);
        (uint256 legIn, uint256 floorOut) = stubBook.currentLeg(id);
        stub.configure(0, 0, address(0), 0);

        MoleRouter.SwapPlan memory p = _twoHopPlan(address(loose), legIn, floorOut);
        vm.prank(keeper);
        stubBook.fillLeg(id, p);

        (,,,,, uint256 spent,,,,) = stubBook.orders(id);
        assertEq(spent, legIn, "the whole leg was charged");
        assertEq(loose.balanceOf(address(stubBook)), 5, "and the book's own balance is still its own");
    }
}
