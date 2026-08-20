package local.remotepcl.input;

import com.sun.tools.attach.VirtualMachine;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Target-process input adapter for Minecraft Java/LWJGL.
 *
 * The agent is attached to the explicitly selected JVM and changes only that
 * Minecraft instance's KeyMapping/player/screen state. It never synthesizes a
 * global Windows input event, moves the system cursor, or follows focus.
 */
final class RemoteInputAgentV10 {
  private static volatile AgentWorker activeWorker;

  private RemoteInputAgentV10() {}

  public static void agentmain(String arguments, Instrumentation instrumentation) {
    Map<String, String> options = parseOptions(arguments);
    int port = Integer.parseInt(require(options, "port"));
    String token = require(options, "token");
    AgentWorker previous = activeWorker;
    if (previous != null) previous.stop();
    AgentWorker worker = new AgentWorker(instrumentation, port, token);
    activeWorker = worker;
    Thread thread = new Thread(worker, "RemotePCL-TargetInput");
    thread.setDaemon(true);
    thread.start();
  }

  public static void main(String[] arguments) throws Exception {
    Map<String, String> options = parseCli(arguments);
    String pid = require(options, "pid");
    String port = require(options, "port");
    String token = require(options, "token");
    File ownJar = new File(RemoteInputAgentV10.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    VirtualMachine vm = VirtualMachine.attach(pid);
    try {
      vm.loadAgent(ownJar.getAbsolutePath(), "port=" + port + ";token=" + token);
    } finally {
      vm.detach();
    }
    System.out.println("REMOTE_INPUT_AGENT_ATTACHED pid=" + pid);
  }

  private static Map<String, String> parseCli(String[] arguments) {
    Map<String, String> result = new HashMap<>();
    for (int index = 0; index < arguments.length; index++) {
      String key = arguments[index];
      if (!key.startsWith("--") || index + 1 >= arguments.length) throw new IllegalArgumentException("Invalid argument: " + key);
      result.put(key.substring(2), arguments[++index]);
    }
    return result;
  }

  private static Map<String, String> parseOptions(String arguments) {
    Map<String, String> result = new HashMap<>();
    if (arguments == null) return result;
    for (String entry : arguments.split(";")) {
      int separator = entry.indexOf('=');
      if (separator > 0) result.put(entry.substring(0, separator), entry.substring(separator + 1));
    }
    return result;
  }

  private static String require(Map<String, String> options, String key) {
    String value = options.get(key);
    if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing " + key);
    return value;
  }

  private static final class AgentWorker implements Runnable {
    private final Instrumentation instrumentation;
    private final int port;
    private final String token;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
      Thread thread = new Thread(runnable, "RemotePCL-KeyRelease");
      thread.setDaemon(true);
      return thread;
    });
    private volatile boolean running = true;
    private volatile Socket socket;
    private MinecraftFacade minecraft;

    AgentWorker(Instrumentation instrumentation, int port, String token) {
      this.instrumentation = instrumentation;
      this.port = port;
      this.token = token;
    }

    @Override public void run() {
      try (Socket connection = new Socket(InetAddress.getByName("127.0.0.1"), port);
           BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
           BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8))) {
        socket = connection;
        connection.setTcpNoDelay(true);
        try {
          minecraft = new MinecraftFacade(instrumentation, scheduler);
        } catch (Throwable error) {
          Throwable cause = error.getCause() == null ? error : error.getCause();
          write(writer, "ERROR\t" + token + "\t" + ProcessHandle.current().pid() + "\t" + encode(cause.toString()));
          return;
        }
        write(writer, "READY\t" + token + "\t" + ProcessHandle.current().pid() + "\t" + encode(minecraft.describe()));
        String line;
        while (running && (line = reader.readLine()) != null) handle(line, writer);
      } catch (Throwable error) {
        // The controller treats socket closure as target-input loss.
      } finally {
        try { if (minecraft != null) minecraft.releaseAll(); } catch (Throwable ignored) {}
        scheduler.shutdownNow();
        running = false;
      }
    }

    void stop() {
      running = false;
      try { if (socket != null) socket.close(); } catch (Exception ignored) {}
      scheduler.shutdownNow();
    }

    private void handle(String line, BufferedWriter writer) throws Exception {
      String[] fields = line.split("\\t", -1);
      long seq = fields.length > 0 ? Long.parseUnsignedLong(fields[0]) : 0;
      try {
        if (fields.length < 2) throw new IllegalArgumentException("INVALID_AGENT_COMMAND");
        String kind = fields[1];
        switch (kind) {
          case "key" -> minecraft.key(Integer.parseInt(fields[3]), fields[2]);
          case "mouseButton" -> minecraft.mouseButton(fields[3], fields[2]);
          case "mouseMove" -> minecraft.look(Double.parseDouble(fields[2]), Double.parseDouble(fields[3]));
          case "pointerAbsolute" -> minecraft.pointer(fields[2], Double.parseDouble(fields[3]), Double.parseDouble(fields[4]));
          case "text" -> minecraft.text(decode(fields[2]));
          case "releaseAll" -> minecraft.releaseAll();
          case "queryState" -> minecraft.queryState();
          default -> throw new IllegalArgumentException("UNSUPPORTED_AGENT_COMMAND:" + kind);
        }
        if (("key".equals(kind) || "mouseButton".equals(kind)) && fields.length > 2 && "tap".equals(fields[2])) Thread.sleep(50);
        MinecraftFacade.ScreenState state = minecraft.screenState();
        write(writer, "ACK\t" + Long.toUnsignedString(seq) + "\tOK\t" + System.nanoTime() + "\t" + (state.open ? "1" : "0") + "\t" + encode(state.className) + "\t" + state.guiWidth + "\t" + state.guiHeight);
      } catch (Throwable error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        write(writer, "ACK\t" + Long.toUnsignedString(seq) + "\tERR\t" + System.nanoTime() + "\t0\t" + encode(cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage()));
      }
    }

    private static void write(BufferedWriter writer, String line) throws Exception {
      writer.write(line);
      writer.newLine();
      writer.flush();
    }
  }

  private static final class MinecraftFacade {
    private final ScheduledExecutorService scheduler;
    private final Object minecraft;
    private final Method execute;
    private final Field optionsField;
    private final Field playerField;
    private final Field screenField;
    private final Map<Integer, String> keyFields = new HashMap<>();
    private final List<String> heldMappingFields = new ArrayList<>();

    MinecraftFacade(Instrumentation instrumentation, ScheduledExecutorService scheduler) throws Exception {
      this.scheduler = scheduler;
      Class<?> minecraftClass = loadedClass(instrumentation, "net.minecraft.client.Minecraft");
      Method getInstance = namedMethod(minecraftClass, "getInstance", 0);
      minecraft = getInstance.invoke(null);
      if (minecraft == null) throw new IllegalStateException("MINECRAFT_INSTANCE_UNAVAILABLE");
      execute = publicMethod(minecraftClass, "execute", Runnable.class);
      optionsField = namedField(minecraftClass, "options");
      playerField = namedField(minecraftClass, "player");
      screenField = namedField(minecraftClass, "screen");
      keyFields.put(0x57, "keyUp");
      keyFields.put(0x53, "keyDown");
      keyFields.put(0x41, "keyLeft");
      keyFields.put(0x44, "keyRight");
      keyFields.put(0x20, "keyJump");
      keyFields.put(0xA2, "keySprint");
      keyFields.put(0xA0, "keyShift");
      keyFields.put(0x45, "keyInventory");
      keyFields.put(0x54, "keyChat");
      keyFields.put(0x51, "keyDrop");
      keyFields.put(0x74, "keyTogglePerspective");
      heldMappingFields.addAll(List.of("keyUp", "keyDown", "keyLeft", "keyRight", "keyJump", "keySprint", "keyShift", "keyAttack", "keyUse", "keyPickItem"));
    }

    String describe() { return "minecraft-agent-v1 pid=" + ProcessHandle.current().pid(); }

    void queryState() throws Exception { onGameThread(() -> null); }

    void key(int virtualKey, String phase) throws Exception {
      if (virtualKey >= 0x31 && virtualKey <= 0x39 && "tap".equals(phase)) {
        selectHotbar(virtualKey - 0x31);
        return;
      }
      if (virtualKey == 0x1B && "tap".equals(phase)) {
        escape();
        return;
      }
      String field = keyFields.get(virtualKey);
      if (field == null) throw new IllegalArgumentException("UNMAPPED_VIRTUAL_KEY:" + virtualKey);
      mapping(field, phase);
    }

    void mouseButton(String button, String phase) throws Exception {
      String field = switch (button) {
        case "left" -> "keyAttack";
        case "right" -> "keyUse";
        case "middle" -> "keyPickItem";
        default -> throw new IllegalArgumentException("UNMAPPED_MOUSE_BUTTON:" + button);
      };
      mapping(field, phase);
    }

    void look(double dx, double dy) throws Exception {
      if (!Double.isFinite(dx) || !Double.isFinite(dy)) throw new IllegalArgumentException("INVALID_LOOK_DELTA");
      onGameThread(() -> {
        Object player = playerField.get(minecraft);
        if (player == null) throw new IllegalStateException("PLAYER_UNAVAILABLE");
        Method turn = methodInHierarchy(player.getClass(), "turn", double.class, double.class);
        turn.invoke(player, dx, dy);
        return null;
      });
    }

    void pointer(String phase, double normalizedX, double normalizedY) throws Exception {
      if (!Double.isFinite(normalizedX) || !Double.isFinite(normalizedY) || normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
        throw new IllegalArgumentException("INVALID_GUI_POINTER");
      }
      onGameThread(() -> {
        Object screen = screenField.get(minecraft);
        if (screen == null) throw new IllegalStateException("GUI_SCREEN_UNAVAILABLE");
        Object window = namedMethod(minecraft.getClass(), "getWindow", 0).invoke(minecraft);
        int width = ((Number) namedMethod(window.getClass(), "getGuiScaledWidth", 0).invoke(window)).intValue();
        int height = ((Number) namedMethod(window.getClass(), "getGuiScaledHeight", 0).invoke(window)).intValue();
        double x = normalizedX * width;
        double y = normalizedY * height;
        if ("move".equals(phase)) namedMethod(screen.getClass(), "mouseMoved", 2).invoke(screen, x, y);
        else if ("down".equals(phase)) namedMethod(screen.getClass(), "mouseClicked", 3).invoke(screen, x, y, 0);
        else if ("up".equals(phase)) namedMethod(screen.getClass(), "mouseReleased", 3).invoke(screen, x, y, 0);
        else if ("tap".equals(phase)) {
          namedMethod(screen.getClass(), "mouseClicked", 3).invoke(screen, x, y, 0);
          namedMethod(screen.getClass(), "mouseReleased", 3).invoke(screen, x, y, 0);
        } else throw new IllegalArgumentException("INVALID_POINTER_PHASE:" + phase);
        return null;
      });
    }

    void text(String value) throws Exception {
      if (value == null || value.isEmpty()) throw new IllegalArgumentException("EMPTY_TEXT");
      onGameThread(() -> {
        Object screen = screenField.get(minecraft);
        if (screen == null) throw new IllegalStateException("GUI_SCREEN_UNAVAILABLE");
        Method charTyped = namedMethod(screen.getClass(), "charTyped", 2);
        for (int offset = 0; offset < value.length();) {
          int codePoint = value.codePointAt(offset);
          offset += Character.charCount(codePoint);
          for (char unit : Character.toChars(codePoint)) charTyped.invoke(screen, unit, 0);
        }
        namedMethod(screen.getClass(), "keyPressed", 3).invoke(screen, 257, 28, 0);
        return null;
      });
    }

    void releaseAll() throws Exception {
      onGameThread(() -> {
        Object options = optionsField.get(minecraft);
        for (String field : heldMappingFields) {
          try { setMappingDown(namedField(options.getClass(), field).get(options), false); } catch (Throwable ignored) {}
        }
        return null;
      });
    }

    ScreenState screenState() throws Exception {
      return onGameThread(() -> {
        Object screen = screenField.get(minecraft);
        Object window = namedMethod(minecraft.getClass(), "getWindow", 0).invoke(minecraft);
        int width = ((Number) namedMethod(window.getClass(), "getGuiScaledWidth", 0).invoke(window)).intValue();
        int height = ((Number) namedMethod(window.getClass(), "getGuiScaledHeight", 0).invoke(window)).intValue();
        return new ScreenState(screen != null, screen == null ? "" : screen.getClass().getName(), width, height);
      });
    }

    private void mapping(String fieldName, String phase) throws Exception {
      if (!List.of("down", "up", "tap").contains(phase)) throw new IllegalArgumentException("INVALID_MAPPING_PHASE:" + phase);
      if ("tap".equals(phase)) {
        onGameThread(() -> { clickMapping(mappingObject(fieldName)); return null; });
        return;
      }
      onGameThread(() -> {
        Object mapping = mappingObject(fieldName);
        if ("down".equals(phase)) clickMapping(mapping);
        setMappingDown(mapping, "down".equals(phase));
        return null;
      });
    }

    private Object mappingObject(String fieldName) throws Exception {
      Object options = optionsField.get(minecraft);
      return namedField(options.getClass(), fieldName).get(options);
    }

    private void clickMapping(Object mapping) throws Exception {
      Field keyField = namedField(mapping.getClass(), "key");
      Object key = keyField.get(mapping);
      Method click = null;
      for (Class<?> cursor = mapping.getClass(); cursor != null && click == null; cursor = cursor.getSuperclass()) {
        for (Method candidate : cursor.getDeclaredMethods()) {
          if (Modifier.isStatic(candidate.getModifiers()) && List.of(aliases("click")).contains(candidate.getName()) && candidate.getParameterCount() == 1 && candidate.getParameterTypes()[0].isInstance(key)) {
            click = candidate;
            break;
          }
        }
      }
      if (click == null) throw new NoSuchMethodException("KeyMapping.click");
      click.setAccessible(true);
      click.invoke(null, key);
    }

    private void setMappingDown(Object mapping, boolean down) throws Exception {
      namedMethod(mapping.getClass(), "setDown", 1).invoke(mapping, down);
    }

    private void selectHotbar(int slot) throws Exception {
      onGameThread(() -> {
        Object player = playerField.get(minecraft);
        if (player == null) throw new IllegalStateException("PLAYER_UNAVAILABLE");
        Object inventory = namedMethod(player.getClass(), "getInventory", 0).invoke(player);
        namedField(inventory.getClass(), "selected").setInt(inventory, slot);
        return null;
      });
    }

    private void escape() throws Exception {
      onGameThread(() -> {
        Object screen = screenField.get(minecraft);
        if (screen != null) {
          // A remote client must be able to resume while the desktop control
          // window has OS focus. Otherwise Minecraft's pause-on-lost-focus
          // loop immediately reopens PauseScreen after setScreen(null).
          namedMethod(minecraft.getClass(), "setWindowActive", 1).invoke(minecraft, true);
          namedMethod(minecraft.getClass(), "setScreen", 1).invoke(minecraft, new Object[] { null });
        }
        else namedMethod(minecraft.getClass(), "pauseGame", 1).invoke(minecraft, false);
        return null;
      });
    }

    private <T> T onGameThread(ThrowingSupplier<T> action) throws Exception {
      CompletableFuture<T> future = new CompletableFuture<>();
      Runnable runnable = () -> {
        try { future.complete(action.get()); }
        catch (Throwable error) { future.completeExceptionally(error); }
      };
      execute.invoke(minecraft, runnable);
      return future.get(1500, TimeUnit.MILLISECONDS);
    }

    static final class ScreenState {
      final boolean open;
      final String className;
      final int guiWidth;
      final int guiHeight;
      ScreenState(boolean open, String className, int guiWidth, int guiHeight) { this.open = open; this.className = className; this.guiWidth = guiWidth; this.guiHeight = guiHeight; }
    }
  }

  @FunctionalInterface private interface ThrowingSupplier<T> { T get() throws Throwable; }

  private static Class<?> loadedClass(Instrumentation instrumentation, String name) throws ClassNotFoundException {
    for (Class<?> candidate : instrumentation.getAllLoadedClasses()) if (candidate.getName().equals(name)) return candidate;
    throw new ClassNotFoundException(name);
  }

  private static Field namedField(Class<?> type, String name) throws NoSuchFieldException {
    for (Class<?> cursor = type; cursor != null; cursor = cursor.getSuperclass()) {
      for (String candidateName : aliases(name)) {
        try {
          Field field = cursor.getDeclaredField(candidateName);
          field.setAccessible(true);
          return field;
        } catch (NoSuchFieldException ignored) {}
      }
    }
    throw new NoSuchFieldException(type.getName() + "." + name);
  }

  private static Method namedMethod(Class<?> type, String name, int parameterCount) throws NoSuchMethodException {
    for (Class<?> cursor = type; cursor != null; cursor = cursor.getSuperclass()) {
      for (Method method : cursor.getDeclaredMethods()) {
        if (List.of(aliases(name)).contains(method.getName()) && method.getParameterCount() == parameterCount) {
          method.setAccessible(true);
          return method;
        }
      }
    }
    for (Method method : type.getMethods()) {
      if (List.of(aliases(name)).contains(method.getName()) && method.getParameterCount() == parameterCount) {
        method.setAccessible(true);
        return method;
      }
    }
    throw new NoSuchMethodException(type.getName() + "." + name + "/" + parameterCount);
  }

  private static Method methodInHierarchy(Class<?> type, String name, Class<?>... parameters) throws NoSuchMethodException {
    for (Class<?> cursor = type; cursor != null; cursor = cursor.getSuperclass()) {
      for (String candidateName : aliases(name)) {
        try {
          Method method = cursor.getDeclaredMethod(candidateName, parameters);
          method.setAccessible(true);
          return method;
        } catch (NoSuchMethodException ignored) {}
      }
    }
    throw new NoSuchMethodException(type.getName() + "." + name);
  }

  private static Method publicMethod(Class<?> type, String name, Class<?>... parameters) throws NoSuchMethodException {
    for (String candidateName : aliases(name)) {
      try {
        Method method = type.getMethod(candidateName, parameters);
        method.setAccessible(true);
        return method;
      } catch (NoSuchMethodException ignored) {}
    }
    for (Method method : type.getMethods()) {
      if (method.getParameterCount() == parameters.length && java.util.Arrays.equals(method.getParameterTypes(), parameters)) {
        method.setAccessible(true);
        return method;
      }
    }
    throw new NoSuchMethodException(type.getName() + "." + name);
  }

  private static String[] aliases(String name) {
    return switch (name) {
      case "getInstance" -> new String[] { name, "m_91087_" };
      case "options" -> new String[] { name, "f_91066_" };
      case "player" -> new String[] { name, "f_91074_" };
      case "screen" -> new String[] { name, "f_91080_" };
      case "keyUp" -> new String[] { name, "f_92085_" };
      case "keyLeft" -> new String[] { name, "f_92086_" };
      case "keyDown" -> new String[] { name, "f_92087_" };
      case "keyRight" -> new String[] { name, "f_92088_" };
      case "keyJump" -> new String[] { name, "f_92089_" };
      case "keyShift" -> new String[] { name, "f_92090_" };
      case "keySprint" -> new String[] { name, "f_92091_" };
      case "keyInventory" -> new String[] { name, "f_92092_" };
      case "keyDrop" -> new String[] { name, "f_92094_" };
      case "keyUse" -> new String[] { name, "f_92095_" };
      case "keyAttack" -> new String[] { name, "f_92096_" };
      case "keyPickItem" -> new String[] { name, "f_92097_" };
      case "keyChat" -> new String[] { name, "f_92098_" };
      case "keyTogglePerspective" -> new String[] { name, "f_92103_" };
      case "key" -> new String[] { name, "f_90816_" };
      case "setDown" -> new String[] { name, "m_7249_" };
      case "click" -> new String[] { name, "m_90835_" };
      case "turn" -> new String[] { name, "m_19884_" };
      case "getInventory" -> new String[] { name, "m_150109_" };
      case "selected" -> new String[] { name, "f_35977_" };
      case "getWindow" -> new String[] { name, "m_91268_" };
      case "getGuiScaledWidth" -> new String[] { name, "m_85445_" };
      case "getGuiScaledHeight" -> new String[] { name, "m_85446_" };
      case "mouseMoved" -> new String[] { name, "m_94757_" };
      case "mouseClicked" -> new String[] { name, "m_6375_" };
      case "mouseReleased" -> new String[] { name, "m_6348_" };
      case "charTyped" -> new String[] { name, "m_5534_" };
      case "keyPressed" -> new String[] { name, "m_7933_" };
      case "onClose" -> new String[] { name, "m_7379_" };
      case "setScreen" -> new String[] { name, "m_91152_" };
      case "setWindowActive" -> new String[] { name, "m_7440_" };
      case "pauseGame" -> new String[] { name, "m_91358_" };
      default -> new String[] { name };
    };
  }

  private static String encode(String value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String decode(String value) {
    return new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
  }
}
