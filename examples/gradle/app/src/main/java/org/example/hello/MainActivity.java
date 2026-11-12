package org.example.hello;
public class MainActivity extends android.app.Activity {
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        android.widget.TextView text = new android.widget.TextView(this);
        text.setText("Hello from a disposable Android builder.");
        text.setGravity(android.view.Gravity.CENTER);
        setContentView(text);
    }
}
