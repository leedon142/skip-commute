package app.skipcommute.demo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 탈 버스 접근 알림을 띄우는 조건 (서울시 arrmsg1 예: '곧 도착', '3분12초후[1번째 전]', '7분후[3번째 전]') */
public class BusApproachTest {

    @Test
    public void soonArrivingMessage() {
        assertTrue(NavigationService.busApproaching("곧 도착", -1, Double.NaN));
    }

    @Test
    public void oneStopAway() {
        assertTrue(NavigationService.busApproaching("3분12초후[1번째 전]", 1, 192));
    }

    @Test
    public void within90Seconds() {
        assertTrue(NavigationService.busApproaching("1분30초후[2번째 전]", 2, 90));
    }

    @Test
    public void farBusDoesNotAlert() {
        assertFalse(NavigationService.busApproaching("7분후[3번째 전]", 3, 420));
        assertFalse(NavigationService.busApproaching("2분후[2번째 전]", 2, 120));
    }

    @Test
    public void unknownOrEndedDoesNotAlert() {
        assertFalse(NavigationService.busApproaching("운행종료", -1, Double.NaN));
        assertFalse(NavigationService.busApproaching("출발대기", -1, Double.NaN));
        assertFalse(NavigationService.busApproaching(null, -1, Double.NaN));
    }
}
