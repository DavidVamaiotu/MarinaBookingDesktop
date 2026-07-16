package ro.marinapark.booking.mobile;

import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundQueue")
public class BackgroundQueuePlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        try {
            ContextCompat.startForegroundService(
                getContext(),
                new Intent(getContext(), BackgroundQueueService.class)
            );
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Nu s-a putut porni sincronizarea în fundal.", error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), BackgroundQueueService.class));
        call.resolve();
    }
}
