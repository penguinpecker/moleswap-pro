// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SwapPreflightProbe} from "../src/periphery/SwapPreflightProbe.sol";

/// @dev A deliberately configurable ERC-20: fee-on-transfer, approve that reverts, a call counter. Everything
///      the probe must see through.
contract ProbeMockToken {
    error ApproveBlocked();

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps; // taken from every transfer's recipient
    bool public approveReverts;
    uint256 public approveCalls;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function setApproveReverts(bool v) external {
        approveReverts = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        approveCalls++;
        if (approveReverts) revert ApproveBlocked();
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[to] += amount - fee;
        return true;
    }
}

/// @dev Stands in for MoleRouter: pulls the input from msg.sender, pays the output, returns it — plus the
///      failure shapes the probe has to carry back faithfully.
contract ProbeMockRouter {
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    error InsufficientOutput(uint256 got, uint256 minOut);

    receive() external payable {}

    function pullAndPay(address tokenIn, uint256 amountIn, address tokenOut, uint256 out, address recipient)
        external
        payable
        returns (uint256)
    {
        if (tokenIn == NATIVE) {
            require(msg.value == amountIn, "bad value");
        } else {
            require(msg.value == 0, "stray value");
            require(ProbeMockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        }
        if (tokenOut == NATIVE) {
            (bool ok,) = recipient.call{value: out}("");
            require(ok, "eth push failed");
        } else {
            require(ProbeMockToken(tokenOut).transfer(recipient, out), "pay failed");
        }
        return out;
    }

    /// @dev Pulls MORE than declared — the hostile shape the balance diff exists to catch.
    function overpull(address tokenIn, uint256 amountIn, uint256 extra) external returns (uint256) {
        require(ProbeMockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn + extra), "pull failed");
        return 0;
    }

    function failWith(uint256 got, uint256 minOut) external payable returns (uint256) {
        revert InsufficientOutput(got, minOut);
    }
}

/// @notice The probe is never deployed: its runtime is injected over the swapper's address by an eth_call state
///         override. These tests do the same with vm.etch and drive it through every shape the frontend's
///         pre-flight (frontend/lib/aggregator/simulate.ts) relies on. The first test pins the bytes the frontend
///         ships against this source.
contract SwapPreflightProbeTest is Test {
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address internal swapper = makeAddr("swapper");
    address internal other = makeAddr("other-recipient");
    ProbeMockToken internal tokenIn;
    ProbeMockToken internal tokenOut;
    ProbeMockRouter internal router;
    SwapPreflightProbe internal probe; // the swapper's address, wearing the probe's code

    function setUp() public {
        tokenIn = new ProbeMockToken();
        tokenOut = new ProbeMockToken();
        router = new ProbeMockRouter();
        vm.etch(swapper, type(SwapPreflightProbe).runtimeCode);
        probe = SwapPreflightProbe(payable(swapper));
        tokenOut.mint(address(router), 1_000e18);
        vm.deal(address(router), 100 ether);
    }

    /* ------------------------------------------------------------------ the frontend carries these bytes */

    function test_frontendArtifactMatchesThisSource() public view {
        string memory json = vm.readFile("frontend/lib/aggregator/preflightProbe.json");
        bytes memory shipped = vm.parseJsonBytes(json, ".runtime");
        assertEq(
            keccak256(shipped),
            keccak256(type(SwapPreflightProbe).runtimeCode),
            "preflightProbe.json runtime drifted from SwapPreflightProbe.sol - regenerate it (see its header)"
        );
        string memory canonical = vm.parseJsonString(json, ".canonical");
        assertEq(
            bytes4(keccak256(bytes(canonical))),
            SwapPreflightProbe.preflight.selector,
            "preflightProbe.json canonical signature does not hash to preflight's selector"
        );
    }

    /* ---------------------------------------------------------------------------- the happy paths */

    function test_erc20In_approvesExactlyAmountIn_whenAllowanceIsShort() public {
        tokenIn.mint(swapper, 10e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 4e18, address(tokenOut), 7e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok), "stage");
        assertEq(r.amountOut, 7e18, "router return");
        assertEq(r.sent, 4e18, "sent");
        assertEq(r.received, 7e18, "received");
        assertEq(r.balanceBefore, 10e18, "balanceBefore");
        assertEq(r.allowanceBefore, 0, "allowanceBefore");
        assertEq(tokenIn.approveCalls(), 1, "approve simulated once");
        // The probe approves as the swapper, for exactly amountIn, to exactly the router — the real flow's shape.
        assertEq(tokenIn.allowance(swapper, address(router)), 0, "allowance consumed by the pull");
    }

    function test_erc20In_skipsApprove_whenAllowanceCovers() public {
        tokenIn.mint(swapper, 10e18);
        vm.prank(swapper);
        tokenIn.approve(address(router), 100e18);
        uint256 callsBefore = tokenIn.approveCalls();
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 4e18, address(tokenOut), 7e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.allowanceBefore, 100e18, "reports the standing allowance");
        assertEq(tokenIn.approveCalls(), callsBefore, "no approve when the allowance already covers amountIn");
    }

    /// @dev The "Max" swap: the swapper holds EXACTLY amountIn. The balance check is `<`, not `<=` — a
    ///      regenerated probe with the boundary off by one would falsely block every whole-balance swap while
    ///      the byte-pin alone stayed silent about WHY. ERC-20 and native both.
    function test_exactBalance_isOk() public {
        tokenIn.mint(swapper, 4e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 4e18, address(tokenOut), 7e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok), "exact ERC-20 balance is enough");
        assertEq(r.balanceBefore, 4e18);
        assertEq(r.sent, 4e18, "the whole balance went");
        assertEq(r.received, 7e18);
        assertEq(tokenIn.balanceOf(swapper), 0, "nothing left - and nothing more was needed");

        vm.deal(swapper, 2 ether);
        data = abi.encodeCall(ProbeMockRouter.pullAndPay, (NATIVE, 2 ether, address(tokenOut), 9e18, swapper));
        r = probe.preflight(address(router), data, 2 ether, NATIVE, address(tokenOut), swapper, 2 ether);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok), "exact native balance is enough");
        assertEq(r.balanceBefore, 2 ether);
        assertEq(r.sent, 2 ether);
        assertEq(r.received, 9e18);
    }

    /// @dev Allowance EXACTLY amountIn (the real flow's own exact approve, still standing) needs no new approve.
    function test_exactAllowance_skipsApprove() public {
        tokenIn.mint(swapper, 10e18);
        vm.prank(swapper);
        tokenIn.approve(address(router), 4e18);
        uint256 callsBefore = tokenIn.approveCalls();
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 4e18, address(tokenOut), 7e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.allowanceBefore, 4e18, "reports the exact standing allowance");
        assertEq(tokenIn.approveCalls(), callsBefore, "allowance == amountIn: no approve simulated");
        assertEq(r.sent, 4e18);
        assertEq(tokenIn.allowance(swapper, address(router)), 0, "consumed exactly by the pull");
    }

    function test_nativeIn_sentIsTheValue() public {
        vm.deal(swapper, 5 ether);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (NATIVE, 2 ether, address(tokenOut), 9e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 2 ether, NATIVE, address(tokenOut), swapper, 2 ether);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.sent, 2 ether, "ETH sent");
        assertEq(r.received, 9e18, "tokens received");
        assertEq(r.allowanceBefore, 0, "no allowance step for native");
        assertEq(tokenIn.approveCalls(), 0, "no approve for native");
    }

    function test_nativeOut_receivedIsEth() public {
        tokenIn.mint(swapper, 10e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 1e18, NATIVE, 3 ether, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), NATIVE, swapper, 1e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.sent, 1e18);
        assertEq(r.received, 3 ether, "ETH received, measured on the swapper's native balance");
    }

    function test_recipientNotSwapper_receivedIsMeasuredAtRecipient() public {
        tokenIn.mint(swapper, 10e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 1e18, address(tokenOut), 5e18, other));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), other, 1e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.received, 5e18, "recipient's delta");
        assertEq(tokenOut.balanceOf(swapper), 0, "swapper got none - and the probe did not mis-attribute it");
    }

    /* -------------------------------------------------------------------------- the failure shapes */

    function test_insufficientBalance_triesNothing() public {
        tokenIn.mint(swapper, 1e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 4e18, address(tokenOut), 7e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.InsufficientBalance));
        assertEq(r.balanceBefore, 1e18);
        assertEq(tokenIn.approveCalls(), 0, "nothing was attempted");
        assertEq(r.sent, 0);
        assertEq(r.received, 0);
    }

    function test_insufficientNativeBalance_triesNothing() public {
        vm.deal(swapper, 1 ether);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (NATIVE, 2 ether, address(tokenOut), 9e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 2 ether, NATIVE, address(tokenOut), swapper, 2 ether);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.InsufficientBalance));
        assertEq(r.balanceBefore, 1 ether);
    }

    function test_approveRevert_carriesTheTokensReason() public {
        tokenIn.mint(swapper, 10e18);
        tokenIn.setApproveReverts(true);
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 4e18, address(tokenOut), 7e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.ApproveFailed));
        assertEq(r.revertData, abi.encodeWithSelector(ProbeMockToken.ApproveBlocked.selector), "token's own revert data");
        assertEq(r.sent, 0);
        assertEq(tokenOut.balanceOf(swapper), 0, "the swap was never attempted");
    }

    function test_swapRevert_bubblesRevertData_andLeavesStateUntouched() public {
        tokenIn.mint(swapper, 10e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.failWith, (123, 456));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.SwapFailed));
        assertEq(
            r.revertData,
            abi.encodeWithSelector(ProbeMockRouter.InsufficientOutput.selector, uint256(123), uint256(456)),
            "the router's typed error, byte for byte"
        );
        assertEq(r.sent, 0, "no delta reported for a failed swap");
        assertEq(r.received, 0);
        assertEq(tokenIn.balanceOf(swapper), 10e18, "the failed call's state was rolled back");
    }

    function test_swapRevertWithoutReason_returnsEmptyRevertData() public {
        tokenIn.mint(swapper, 10e18);
        // Calling a selector the router does not have: reverts with empty data.
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), hex"deadbeef", 0, address(tokenIn), address(tokenOut), swapper, 4e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.SwapFailed));
        assertEq(r.revertData.length, 0);
    }

    /* ----------------------------------------------------- what a plain eth_call cannot see, and this can */

    function test_feeOnTransferOutput_receivedIsLessThanRouterReturn() public {
        tokenIn.mint(swapper, 10e18);
        tokenOut.setFeeBps(500); // 5% taken from every recipient
        bytes memory data = abi.encodeCall(ProbeMockRouter.pullAndPay, (address(tokenIn), 1e18, address(tokenOut), 100e18, swapper));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 1e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.amountOut, 100e18, "what the router says it pushed");
        assertEq(r.received, 95e18, "what the recipient actually kept");
        assertLt(r.received, r.amountOut, "the gap a return-value check is blind to");
    }

    function test_overpull_sentExceedsDeclaredAmountIn() public {
        tokenIn.mint(swapper, 10e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.overpull, (address(tokenIn), 1e18, 3e18));
        // The real flow approves exactly amountIn, so an honest over-pull fails on allowance. Give the hostile
        // router a wider allowance to show the probe REPORTS the over-pull rather than hiding it.
        vm.prank(swapper);
        tokenIn.approve(address(router), 100e18);
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 1e18);
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.Ok));
        assertEq(r.sent, 4e18, "the probe reports what was really taken");
        assertGt(r.sent, 1e18, "more than the declared input - the frontend blocks on this");
    }

    function test_exactAllowance_blocksAnOverpullInTheRealShape() public {
        tokenIn.mint(swapper, 10e18);
        bytes memory data = abi.encodeCall(ProbeMockRouter.overpull, (address(tokenIn), 1e18, 3e18));
        SwapPreflightProbe.Result memory r =
            probe.preflight(address(router), data, 0, address(tokenIn), address(tokenOut), swapper, 1e18);
        // With the exact approve the real flow sends, the over-pull reverts on allowance: stage 3, and the
        // reason is the token's own string, carried back intact.
        assertEq(r.stage, uint8(SwapPreflightProbe.Stage.SwapFailed));
        assertEq(r.revertData, abi.encodeWithSignature("Error(string)", "insufficient allowance"));
    }
}
