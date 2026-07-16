package ro.marinapark.booking.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AutoUpdaterPlugin.class);
        registerPlugin(BackgroundQueuePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
